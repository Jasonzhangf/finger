/**
 * BaseSessionAgent - 统一会话管理基类
 * 
 * 功能:
 * 1. 集成 iFlow SDK 连接管理
 * 2. 支持多 agent context 切换的会话管理
 * 3. 子类只需要实现具体的处理逻辑
 */

import { logger } from '../../core/logger.js';
import { IflowBaseAgent } from '../sdk/iflow-base.js';

const log = logger.module('BaseSessionAgent');
import type { MessageHub } from '../../orchestration/message-hub.js';
import {
  ISessionManager,
  SessionMessage,
} from '../chat/session-types.js';


export interface BaseSessionAgentConfig {
  id: string;
  name: string;
  modelId: string;
  systemPrompt?: string;
  chatSystemPrompt?: string;
  routerSystemPrompt?: string;
  maxContextMessages?: number;
}

export interface AgentContext {
  agentId: string;
  agentName: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}

export abstract class BaseSessionAgent extends IflowBaseAgent {
  protected config: BaseSessionAgentConfig;
  protected sessionManager: ISessionManager | null = null;
  protected hub: MessageHub | null = null;
  protected currentContext: AgentContext | null = null;
  protected agentContexts: Map<string, AgentContext> = new Map(); // agentId -> context

  constructor(config: BaseSessionAgentConfig) {
    super();
    this.config = config;
  }

  /**
   * 初始化 Agent - 连接 iFlow 并注册到 Message Hub
   */
  async initializeHub(hub: MessageHub, sessionManager: ISessionManager): Promise<void> {
    this.hub = hub;
    this.sessionManager = sessionManager;
    
    // 初始化 iFlow 连接
    await super.initialize(false);
    log.info(`${this.config.name} connected to iFlow`, { sessionId: this.info.sessionId });

    // 子类注册 input/output
    await this.registerHandlers(hub);
  }

  /**
   * 子类实现：注册 input/output handlers
   */
  protected abstract registerHandlers(hub: MessageHub): Promise<void> | void;

  /**
   * 子类实现：处理消息的核心逻辑
   */
  protected abstract handleMessage(input: unknown, context: AgentContext): Promise<unknown>;

  /**
   * 创建或切换到指定 agent 的会话上下文
   */
  protected async ensureAgentContext(agentId: string, agentName: string, title?: string): Promise<AgentContext> {
    // 检查是否已有该 agent 的 context
    let context = this.agentContexts.get(agentId);
    if (context) {
      this.currentContext = context;
      return context;
    }

    // 创建新 session
    if (!this.sessionManager) {
      throw new Error('SessionManager not initialized');
    }

    const session = await this.sessionManager.createSession({
      title: title || `${agentName} - ${new Date().toLocaleString()}`,
      metadata: { agentId, agentName },
    });

    context = {
      agentId,
      agentName,
      sessionId: session.id,
    };

    this.agentContexts.set(agentId, context);
    this.currentContext = context;
    log.info(`Created context for agent ${agentId}`, { sessionId: session.id });

    return context;
  }

  /**
   * 获取指定 agent 的 context
   */
  protected getAgentContext(agentId: string): AgentContext | undefined {
    return this.agentContexts.get(agentId);
  }

  /**
   * 切换当前 context 到指定 agent
   */
  protected switchToAgent(agentId: string): boolean {
    const context = this.agentContexts.get(agentId);
    if (context) {
      this.currentContext = context;
      return true;
    }
    return false;
  }

  /**
   * 添加消息到当前或指定 agent 的 session
   */
  protected async addMessageToContext(
    role: 'user' | 'assistant' | 'system',
    content: string,
    agentId?: string
  ): Promise<SessionMessage | null> {
    if (!this.sessionManager) return null;

    const context = agentId ? this.agentContexts.get(agentId) : this.currentContext;
    if (!context) return null;

    return this.sessionManager.addMessage(context.sessionId, { role, content });
  }

  /**
   * 获取当前或指定 agent 的消息历史
   */
  protected async getContextHistory(agentId?: string, limit?: number): Promise<SessionMessage[]> {
    if (!this.sessionManager) return [];

    const context = agentId ? this.agentContexts.get(agentId) : this.currentContext;
    if (!context) return [];

    return this.sessionManager.getMessageHistory(context.sessionId, limit);
  }

  /**
   * 调用 LLM 获取回复
   */

  /**
   * 调用 LLM 获取回复 - 使用 iFlow SDK 的 sendMessage + receiveMessages
   */
  protected async callLLM(
    userMessage: string,
    systemPrompt?: string,
    history?: SessionMessage[]
  ): Promise<string> {
    if (!this.client) {
      throw new Error('iFlow client not initialized');
    }

    let fullMessage = userMessage;
    const parts: string[] = [];
    
    if (systemPrompt || this.config.systemPrompt) {
      parts.push(`[系统指令] ${systemPrompt || this.config.systemPrompt}`);
    }
    
    if (history && history.length > 0) {
      const recentHistory = history.slice(-(this.config.maxContextMessages || 20));
      for (const msg of recentHistory) {
        const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统';
        parts.push(`[${roleLabel}] ${msg.content}`);
      }
    }
    
    if (parts.length > 0) {
      parts.push(`[用户] ${userMessage}`);
      fullMessage = parts.join('\n\n');
    }

    try {
      log.debug('Sending message to iFlow', { messageLength: fullMessage.length });
      await this.client.sendMessage(fullMessage);
      
      let finalOutput = '';
      for await (const msg of this.client.receiveMessages()) {
        if (msg.type === 'assistant' && 'chunk' in msg) {
          const chunk = (msg as { chunk?: { text?: string } }).chunk;
          if (chunk?.text) {
            finalOutput += chunk.text;
          }
        } else if (msg.type === 'task_finish') {
          break;
        } else if (msg.type === 'error') {
          const errorMsg = (msg as { message?: string }).message || 'Unknown error';
          throw new Error(`iFlow error: ${errorMsg}`);
        }
      }

      log.debug('Received iFlow response', { responseLength: finalOutput.length });
      return finalOutput || '抱歉，我没有收到回复。';
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('LLM call failed', err);
      return `抱歉，对话服务暂时不可用：${err.message}`;
    }
  }

  /**
   * 获取所有活跃的 agent contexts
   */
  getActiveContexts(): AgentContext[] {
    return Array.from(this.agentContexts.values());
  }

  /**
   * 销毁 agent，清理资源
   */
  async destroyAgent(): Promise<void> {
    this.agentContexts.clear();
    this.currentContext = null;
    // IflowBaseAgent doesn't have destroy method
    log.info(`${this.config.name} destroyed`);
  }
}

export default BaseSessionAgent;
