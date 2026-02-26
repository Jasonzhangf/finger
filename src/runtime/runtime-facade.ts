/**
 * RuntimeFacade - 统一运行时门面
 * 提供给基础子 Agent 使用的统一接口
 */

import type { WebSocket } from 'ws';
import path from 'path';
import { homedir } from 'os';
import { UnifiedEventBus } from './event-bus.js';
import { ToolRegistry } from './tool-registry.js';
import type { RuntimeEvent, Attachment } from './events.js';
import { AgentToolAccessControl, type AgentToolPolicy } from './agent-tool-access.js';
import { applyRoleToolPolicy, type RoleToolPolicyPresetMap } from './agent-tool-role-policy.js';
import {
  ToolAuthorizationManager,
  type AuthorizationIssueOptions,
  type ToolAuthorizationGrant,
} from './tool-authorization.js';

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

export interface AgentProviderRuntimeConfig {
  type: string;
  model?: string;
  options?: Record<string, unknown>;
}

export interface AgentSessionRuntimeConfig {
  bindingScope?: 'finger' | 'finger+agent';
  resume?: boolean;
  provider?: string;
  agentId?: string;
  mapPath?: string;
}

export interface AgentIflowGovernanceRuntimeConfig {
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  injectCapabilities?: boolean;
  capabilityIds?: string[];
  commandNamespace?: string;
}

export interface AgentGovernanceRuntimeConfig {
  iflow?: AgentIflowGovernanceRuntimeConfig;
}

export interface AgentRuntimeConfig {
  id: string;
  name?: string;
  role?: string;
  provider?: AgentProviderRuntimeConfig;
  session?: AgentSessionRuntimeConfig;
  governance?: AgentGovernanceRuntimeConfig;
  model?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export class RuntimeFacade {
  private currentSessionId: string | null = null;
  private readonly toolAccessControl = new AgentToolAccessControl();
  private readonly toolAuthorization = new ToolAuthorizationManager();
  private roleToolPolicyPresets: RoleToolPolicyPresetMap = {};
  private readonly agentRuntimeConfigs = new Map<string, AgentRuntimeConfig>();

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
    this.eventBus.enablePersistence(session.id, path.join(homedir(), '.finger', 'events'));

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
      this.eventBus.enablePersistence(sessionId, path.join(homedir(), '.finger', 'events'));
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
    options: { authorizationToken?: string } = {},
  ): Promise<unknown> {
    const startTime = Date.now();
    const toolId = `${agentId}-${toolName}-${startTime}`;
    const sessionId = this.currentSessionId || 'default';

    const access = this.toolAccessControl.canUse(agentId, toolName);
    if (!access.allowed) {
      this.eventBus.emit({
        type: 'tool_error',
        toolId,
        toolName,
        agentId,
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { error: access.reason, duration: 0 },
      });
      throw new Error(access.reason);
    }

    // 检查策略
    const policy = this.toolRegistry.getPolicy(toolName);
    if (policy === 'deny') {
      throw new Error(`Tool ${toolName} is not allowed`);
    }

    if (this.toolAuthorization.isToolRequired(toolName)) {
      const auth = this.toolAuthorization.verifyAndConsume(options.authorizationToken, agentId, toolName);
      if (!auth.allowed) {
        this.eventBus.emit({
          type: 'tool_error',
          toolId,
          toolName,
          agentId,
          sessionId,
          timestamp: new Date().toISOString(),
          payload: { error: auth.reason, duration: 0 },
        });
        throw new Error(auth.reason);
      }
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
        payload: { input, output: result, duration },
      });

      if (toolName === 'view_image') {
        this.appendViewImageAttachmentEvent(sessionId, result);
      }

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
        payload: { input, error: String(error), duration },
      });

      throw error;
    }
  }

  private appendViewImageAttachmentEvent(sessionId: string, toolResult: unknown): void {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return;

    const attachment = this.extractViewImageAttachment(toolResult);
    if (!attachment) return;

    const content = `[view_image] ${attachment.name}`;
    const message = this.sessionManager.addMessage(sessionId, 'user', content, {
      attachments: [attachment],
    });
    if (!message) return;

    this.eventBus.emit({
      type: 'user_message',
      sessionId,
      timestamp: message.timestamp,
      payload: {
        messageId: message.id,
        content,
        attachments: [attachment],
      },
    });
  }

  private extractViewImageAttachment(toolResult: unknown): Attachment | null {
    if (!isRecord(toolResult)) return null;
    if (toolResult.ok !== true) return null;
    if (typeof toolResult.path !== 'string' || toolResult.path.trim().length === 0) return null;
    if (typeof toolResult.mimeType !== 'string' || !toolResult.mimeType.startsWith('image/')) return null;

    const fullPath = toolResult.path.trim();
    const fileName = path.basename(fullPath);
    const attachment: Attachment = {
      id: `view-image-${Date.now()}`,
      name: fileName.length > 0 ? fileName : fullPath,
      type: 'image',
      url: fullPath,
    };
    if (typeof toolResult.sizeBytes === 'number' && Number.isFinite(toolResult.sizeBytes)) {
      attachment.size = Math.max(0, Math.floor(toolResult.sizeBytes));
    }
    return attachment;
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

  /**
   * 授予 agent 工具白名单权限
   */
  grantToolToAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.grant(agentId, toolName);
  }

  /**
   * 撤销 agent 工具白名单权限
   */
  revokeToolFromAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.revoke(agentId, toolName);
  }

  /**
   * 设置 agent 工具白名单
   */
  setAgentToolWhitelist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setWhitelist(agentId, toolNames);
  }

  /**
   * 设置 agent 工具黑名单
   */
  setAgentToolBlacklist(agentId: string, toolNames: string[]): AgentToolPolicy {
    return this.toolAccessControl.setBlacklist(agentId, toolNames);
  }

  /**
   * 将单个工具加入 agent 黑名单
   */
  denyToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.deny(agentId, toolName);
  }

  /**
   * 从 agent 黑名单移除单个工具
   */
  allowToolForAgent(agentId: string, toolName: string): AgentToolPolicy {
    return this.toolAccessControl.allow(agentId, toolName);
  }

  /**
   * 获取 agent 工具权限策略
   */
  getAgentToolPolicy(agentId: string): AgentToolPolicy {
    return this.toolAccessControl.getPolicy(agentId);
  }

  /**
   * 清空 agent 工具权限策略
   */
  clearAgentToolPolicy(agentId: string): void {
    this.toolAccessControl.clear(agentId);
  }

  /**
   * 设置 agent 运行时配置（provider/session/governance）
   */
  setAgentRuntimeConfig(agentId: string, config: AgentRuntimeConfig): AgentRuntimeConfig {
    const normalized: AgentRuntimeConfig = {
      ...config,
      id: agentId,
    };
    this.agentRuntimeConfigs.set(agentId, normalized);
    return normalized;
  }

  /**
   * 读取 agent 运行时配置
   */
  getAgentRuntimeConfig(agentId: string): AgentRuntimeConfig | null {
    return this.agentRuntimeConfigs.get(agentId) ?? null;
  }

  /**
   * 清空 agent 运行时配置
   */
  clearAgentRuntimeConfig(agentId: string): void {
    this.agentRuntimeConfigs.delete(agentId);
  }

  /**
   * 列出所有 agent 运行时配置
   */
  listAgentRuntimeConfigs(): AgentRuntimeConfig[] {
    return Array.from(this.agentRuntimeConfigs.values())
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 根据角色模板设置工具策略
   */
  applyAgentRoleToolPolicy(agentId: string, role: string): AgentToolPolicy {
    return applyRoleToolPolicy(this.toolAccessControl, agentId, role, this.roleToolPolicyPresets);
  }

  /**
   * 设置角色策略模板（由配置文件驱动）
   */
  setRoleToolPolicyPresets(presets: RoleToolPolicyPresetMap): string[] {
    const next: RoleToolPolicyPresetMap = {};
    for (const [key, preset] of Object.entries(presets)) {
      const roleKey = key.trim().toLowerCase();
      if (roleKey.length === 0) continue;
      next[roleKey] = {
        role: preset.role,
        whitelist: [...preset.whitelist],
        blacklist: [...preset.blacklist],
      };
    }
    this.roleToolPolicyPresets = next;
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 返回可用角色策略名称
   */
  listRoleToolPolicyPresets(): string[] {
    return Object.keys(this.roleToolPolicyPresets).sort();
  }

  /**
   * 设置工具是否需要授权令牌
   */
  setToolAuthorizationRequired(toolName: string, required: boolean): void {
    this.toolAuthorization.setToolRequired(toolName, required);
  }

  /**
   * 为 agent + tool 签发一次性/多次授权令牌
   */
  issueToolAuthorization(
    agentId: string,
    toolName: string,
    issuedBy: string,
    options: AuthorizationIssueOptions = {},
  ): ToolAuthorizationGrant {
    return this.toolAuthorization.issue(agentId, toolName, issuedBy, options);
  }

  /**
   * 吊销授权令牌
   */
  revokeToolAuthorization(token: string): boolean {
    return this.toolAuthorization.revoke(token);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
