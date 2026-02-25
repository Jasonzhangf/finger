/**
 * BaseAgent - 所有 Agent 的基础类
 * 
 * 提供通用的 Agent 功能：
 * 1. Session 管理（创建/恢复/持久化）
 * 2. 历史记录管理（消息 CRUD）
 * 3. 状态管理（状态机）
 * 4. 状态更新广播（EventBus）
 * 5. 会话管理（多轮对话上下文）
 */

import { IflowBaseAgent } from '../sdk/iflow-base.js';
import { IflowSessionManager } from '../chat/iflow-session-manager.js';
import { setGlobalSessionManager } from '../chat/session-types.js';
import type { Session, SessionMessage } from '../chat/session-types.js';
import { SessionStatus } from '../chat/session-types.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { globalEventBus } from '../../runtime/event-bus.js';
import { logger } from '../../core/logger.js';

const log = logger.module('BaseAgent');

// ========== 状态定义 ==========
export type AgentStatus = 
  | 'pending'
  | 'thinking'
  | 'analyzing'
  | 'routing'
  | 'executing'
  | 'responding'
  | 'completed'
  | 'failed'
  | 'paused';

export interface AgentState {
  status: AgentStatus;
  phase: string;
  message?: string;
  error?: string;
  result?: unknown;
  timestamp: string;
}

// ========== 配置 ==========
export interface BaseAgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  modelId: string;
  maxContextMessages: number;
  sessionTtlDays: number;
}

const DEFAULT_CONFIG: BaseAgentConfig = {
  id: 'base-agent',
  name: 'Base Agent',
  systemPrompt: '你是一个 AI 助手。',
  modelId: 'gpt-4',
  maxContextMessages: 20,
  sessionTtlDays: 30,
};

// ========== 基础 Agent 类 ==========
export abstract class BaseAgent extends IflowBaseAgent {
  protected config: BaseAgentConfig;
  protected sessionManager: IflowSessionManager;
  protected currentSession: Session | null = null;
  protected currentState: AgentState = {
    status: 'pending',
    phase: 'idle',
    timestamp: new Date().toISOString(),
  };

  constructor(config: Partial<BaseAgentConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionManager = new IflowSessionManager();
  }

  /**
   * 初始化 Agent（所有子类通用）
   */
  async initializeBase(hub: MessageHub): Promise<void> {
    log.info(`Initializing ${this.config.name}...`);
    
    // 1. 初始化 iFlow 连接
    await this.initialize(false);
    log.info('Connected to iFlow', { sessionId: this.info.sessionId });
    
    // 2. 初始化 Session Manager
    await this.sessionManager.initialize();
    setGlobalSessionManager(this.sessionManager);
    log.info('Session manager initialized');
    
    // 3. 恢复会话
    await this.restoreSession();
    
    // 4. 发送初始化事件
    this.emitStatusUpdate('pending', 'initialized', `${this.config.name} 已初始化`);
    
    // 5. 子类特定的初始化
    await this.onInitialize(hub);
  }

  /**
   * 子类实现：特定的初始化逻辑
   */
  protected abstract onInitialize(hub: MessageHub): Promise<void>;

  /**
   * 获取或创建会话
   */
  protected async getOrCreateSession(sessionId?: string, title?: string): Promise<Session> {
    if (sessionId) {
      const existing = await this.sessionManager.getSession(sessionId);
      if (existing) {
        this.currentSession = existing;
        return existing;
      }
    }
    
    // 创建新会话
    const session = await this.sessionManager.createSession({
      title: title || `${this.config.name} - ${new Date().toLocaleString()}`,
      metadata: { agentId: this.config.id },
    });
    
    this.currentSession = session;
    log.info('Created new session', { sessionId: session.id });
    
    return session;
  }

  /**
   * 恢复会话
   */
  protected async restoreSession(): Promise<void> {
    const sessions = await this.sessionManager.querySessions({
      status: SessionStatus.ACTIVE,
      limit: 1,
      sortBy: 'lastActivityAt',
      sortOrder: 'desc',
    });
    
    if (sessions.length > 0) {
      this.currentSession = sessions[0];
      log.info('Restored session', { sessionId: this.currentSession.id });
    }
  }

  /**
   * 添加消息到历史
   */
  protected async addMessage(
    role: 'user' | 'assistant' | 'system',
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<SessionMessage> {
    if (!this.currentSession) {
      await this.getOrCreateSession();
    }
    
    const message = await this.sessionManager.addMessage(this.currentSession!.id, {
      role,
      content,
      metadata: {
        ...metadata,
        agentId: this.config.id,
      },
    });
    
    return message;
  }

  /**
   * 获取历史消息
   */
  protected async getHistory(limit?: number): Promise<SessionMessage[]> {
    if (!this.currentSession) return [];
    return await this.sessionManager.getMessageHistory(this.currentSession.id, limit);
  }

  /**
   * 发送状态更新（核心功能）
   */
  protected emitStatusUpdate(
    status: AgentStatus,
    phase: string,
    message?: string,
    data?: Record<string, unknown>
  ): void {
    this.currentState = {
      status,
      phase,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    };
    
    // 发送到 EventBus - 使用现有的事件类型
    globalEventBus.emit({
      type: 'agent_step_completed',
      agentId: this.config.id,
      agentName: this.config.name,
      step: phase,
      status: status as any,
      thought: message,
      data: {
        ...this.currentState,
        sessionId: this.currentSession?.id,
      },
      timestamp: this.currentState.timestamp,
    } as any);
    
    log.debug(`Status update: ${status}/${phase}`, { message });
  }

  /**
   * 调用 LLM（统一接口）
   */
  protected async callLLM(
    userMessage: string,
    systemPrompt?: string,
    history?: SessionMessage[]
  ): Promise<string> {
    if (!this.client) {
      throw new Error('iFlow client not initialized');
    }

    // 发送 LLM 调用事件
    this.emitStatusUpdate('thinking', 'llm_call', '正在调用 LLM...');

    const messages = [
      { role: 'system', content: systemPrompt || this.config.systemPrompt },
      ...(history || await this.getHistory(this.config.maxContextMessages)).map(m => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    try {
      const response = await (this.client as { chat?: (params: { messages: Array<{ role: string; content: string }>; model: string }) => Promise<{ content?: string }> | string }).chat?.({
        messages,
        model: this.config.modelId,
      });

      const content = typeof response === 'string' ? response : (response?.content || '');
      
      // 发送 LLM 响应事件
      this.emitStatusUpdate('analyzing', 'llm_response', 'LLM 响应已收到', {
        responseLength: content.length,
      });
      
      return content;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitStatusUpdate('failed', 'llm_error', `LLM 调用失败：${err.message}`);
      throw err;
    }
  }

  /**
   * 清理资源
   */
  async destroy(): Promise<void> {
    log.info(`Destroying ${this.config.name}...`);
    await this.sessionManager.destroy();
    await this.disconnect?.();
    this.emitStatusUpdate('completed', 'destroyed', 'Agent 已销毁');
  }

  /**
   * 获取当前状态
   */
  getCurrentState(): AgentState {
    return { ...this.currentState };
  }

  /**
   * 获取当前会话
   */
  getCurrentSession(): Session | null {
    return this.currentSession;
  }

  /**
   * 获取配置
   */
  getConfig(): BaseAgentConfig {
    return { ...this.config };
  }
}

export default BaseAgent;
