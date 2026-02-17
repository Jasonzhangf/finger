/**
 * RuntimeFacade - 统一运行时门面
 * 提供给基础子 Agent 使用的统一接口
 */

import type { WebSocket } from 'ws';
import { UnifiedEventBus } from './event-bus.js';
import { ToolRegistry } from './tool-registry.js';
import type { RuntimeEvent, Attachment } from './events.js';

// Session 类型 (简化版，完整定义在 session-manager.ts)
export interface SessionInfo {
  id: string;
  name: string;
  projectPath: string;
  status?: 'active' | 'paused' | 'completed' | 'error';
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
}

// 进度报告
export interface ProgressReport {
  overall: number;
  activeAgents: string[];
  pending: number;
  completed: number;
  failed: number;
}

// 会话管理器接口
export interface ISessionManager {
  createSession(projectPath: string, name?: string): SessionInfo | Promise<SessionInfo>;
  getSession(sessionId: string): SessionInfo | undefined;
  getCurrentSession(): SessionInfo | null;
  setCurrentSession(sessionId: string): boolean;
  listSessions(): SessionInfo[];
  addMessage(sessionId: string, role: string, content: string, metadata?: { attachments?: Attachment[] }): { id: string; timestamp: string } | null;
  getMessages(sessionId: string, limit?: number): Array<{ id: string; role: string; content: string; timestamp: string }>;
  deleteSession(sessionId: string): boolean;
  pauseSession?(sessionId: string): boolean;
  resumeSession?(sessionId: string): boolean;
  compressContext?(sessionId: string, summarizer?: unknown): Promise<string>;
  getCompressionStatus?(sessionId: string): { compressed: boolean; summary?: string; originalCount?: number };
  isPaused?(sessionId: string): boolean;
}

export class RuntimeFacade {
  private currentSessionId: string | null = null;

  constructor(
    private eventBus: UnifiedEventBus,
    private sessionManager: ISessionManager,
    private toolRegistry: ToolRegistry,
  private wsClients?: Set<WebSocket>,
  ) {
    // 如果提供了 wsClients，注册到 eventBus
    if (wsClients) {
      // eventBus 将在发送时直接检查 wsClients
    }
  }

  // ==================== Session 管理 ====================

  /**
   * 创建会话
   */
  async createSession(projectPath: string, name?: string): Promise<SessionInfo> {
    const result = this.sessionManager.createSession(projectPath, name);
    const session = result instanceof Promise ? await result : result;
    this.currentSessionId = session.id;

    this.eventBus.emit({
      type: 'session_created',
      sessionId: session.id,
      timestamp: new Date().toISOString(),
      payload: {
        name: session.name,
        projectPath: session.projectPath,
        messageCount: 0,
      },
    });

    return session;
  }

  /**
   * 获取会话
   */
  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  /**
   * 获取当前会话
   */
  getCurrentSession(): SessionInfo | null {
    return this.sessionManager.getCurrentSession();
  }

  /**
   * 设置当前会话
   */
  setCurrentSession(sessionId: string): boolean {
    const result = this.sessionManager.setCurrentSession(sessionId);
    if (result) {
      this.currentSessionId = sessionId;
    }
    return result;
  }

  /**
   * 列出所有会话
   */
  listSessions(): SessionInfo[] {
    return this.sessionManager.listSessions();
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    const result = this.sessionManager.deleteSession(sessionId);
    if (result && this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    return result;
  }

  // ==================== 消息管理 ====================

  /**
   * 发送用户消息
   */
  async sendMessage(
    sessionId: string,
    content: string,
    attachments?: Attachment[],
  ): Promise<{ messageId: string }> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const message = this.sessionManager.addMessage(sessionId, 'user', content, { attachments });
    if (!message) {
      throw new Error(`Failed to append message to session ${sessionId}`);
    }

    this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments,
      },
    });

    return { messageId: message.id };
  }

  /**
   * 添加助手消息块 (流式)
   */
  emitAssistantChunk(sessionId: string, agentId: string, messageId: string, content: string): void {
    this.eventBus.emit({
      type: 'assistant_chunk',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
      },
    });
  }

  /**
   * 添加助手消息完成
   */
  emitAssistantComplete(sessionId: string, agentId: string, messageId: string, content: string, stopReason?: string): void {
    this.eventBus.emit({
      type: 'assistant_complete',
      sessionId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: {
        messageId,
        content,
        stopReason,
      },
    });
  }

  // ==================== 工具调用 ====================

  /**
   * 调用工具
   */
  async callTool(
    agentId: string,
    toolName: string,
    input: unknown,
  ): Promise<unknown> {
    const startTime = Date.now();
    const toolId = `${agentId}-${toolName}-${startTime}`;
    const sessionId = this.currentSessionId || 'default';

    // 检查策略
    const policy = this.toolRegistry.getPolicy(toolName);
    if (policy === 'deny') {
      throw new Error(`Tool ${toolName} is not allowed`);
    }

    // 发送 tool_call 事件
    this.eventBus.emit({
      type: 'tool_call',
      toolId,
      toolName,
      agentId,
      sessionId,
      timestamp: new Date().toISOString(),
      payload: { input },
    });

    try {
      const result = await this.toolRegistry.execute(toolName, input);
      const duration = Date.now() - startTime;

      // 发送 tool_result 事件
      this.eventBus.emit({
        type: 'tool_result',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { output: result, duration },
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      // 发送 tool_error 事件
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: String(error), duration },
      });

      throw error;
    }
  }

  /**
   * 注册工具
   */
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: unknown;
    handler: (input: unknown) => Promise<unknown>;
    policy?: 'allow' | 'deny';
  }): void {
    this.toolRegistry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: tool.handler,
      policy: tool.policy || 'allow',
    });
  }

  /**
   * 设置工具策略
   */
  setToolPolicy(toolName: string, policy: 'allow' | 'deny'): boolean {
    return this.toolRegistry.setPolicy(toolName, policy);
  }

  /**
   * 列出工具
   */
  listTools(): Array<{ name: string; description: string; policy: 'allow' | 'deny' }> {
    return this.toolRegistry.list();
  }

  // ==================== 任务进度 ====================

  /**
   * 报告任务开始
   */
  emitTaskStarted(sessionId: string, taskId: string, title: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_started',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { title },
    });
  }

  /**
   * 报告任务进度
   */
  emitTaskProgress(sessionId: string, taskId: string, progress: number, message?: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_progress',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { progress, message },
    });
  }

  /**
   * 报告任务完成
   */
  emitTaskCompleted(sessionId: string, taskId: string, result?: unknown, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_completed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { result },
    });
  }

  /**
   * 报告任务失败
   */
  emitTaskFailed(sessionId: string, taskId: string, error: string, agentId?: string): void {
    this.eventBus.emit({
      type: 'task_failed',
      sessionId,
      taskId,
      agentId,
      timestamp: new Date().toISOString(),
      payload: { error },
    });
  }

  // ==================== 工作流进度 ====================

  /**
   * 报告工作流进度
   */
  reportProgress(sessionId: string, progress: ProgressReport): void {
    this.eventBus.emit({
      type: 'workflow_progress',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        overallProgress: progress.overall,
        activeAgents: progress.activeAgents,
        pendingTasks: progress.pending,
        completedTasks: progress.completed,
        failedTasks: progress.failed,
      },
    });
  }

  /**
   * 报告 Plan 更新
   */
  emitPlanUpdated(sessionId: string, planId: string, version: number, taskCount: number, completedCount: number): void {
    this.eventBus.emit({
      type: 'plan_updated',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        planId,
        version,
        taskCount,
        completedCount,
      },
    });
  }

  // ==================== 上下文压缩 ====================

  /**
   * 压缩上下文
   */
  async compressContext(sessionId: string): Promise<string> {
    if (!this.sessionManager.compressContext) {
      throw new Error('Context compression not supported by session manager');
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const originalSize = session.messageCount ?? 0;
    const summary = await this.sessionManager.compressContext(sessionId);
    const compressedSize = summary.length;

    this.eventBus.emit({
      type: 'session_compressed',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        originalSize,
        compressedSize,
        summary,
      },
    });

    return summary;
  }

  // ==================== 事件订阅 ====================

  /**
   * 订阅事件
   */
  subscribe(eventType: string, handler: (event: RuntimeEvent) => void): () => void {
    return this.eventBus.subscribe(eventType, handler);
  }

  /**
   * 获取事件历史
   */
  getEventHistory(sessionId?: string, limit?: number): RuntimeEvent[] {
    if (sessionId) {
      return this.eventBus.getSessionHistory(sessionId, limit);
    }
    return this.eventBus.getHistory(limit);
  }
}
