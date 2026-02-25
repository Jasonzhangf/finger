/**
 * Chat Agent - 通用对话 Agent (基于 BaseSessionAgent)
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';
import { BaseSessionAgent, type AgentContext } from '../base/base-session-agent.js';
import { IflowSessionManager } from './iflow-session-manager.js';
import { setGlobalSessionManager } from './session-types.js';
import { type Session, SessionStatus } from './session-types.js';

const log = logger.module('ChatAgent');

export interface ChatAgentConfig {
  id: string;
  name: string;
  modelId: string;
  systemPrompt?: string;
  maxContextMessages?: number;
}

export interface ChatInput {
  text: string;
  sessionId?: string;
  createNewSession?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ChatOutput {
  success: boolean;
  response?: string;
  sessionId: string;
  messageId?: string;
  error?: string;
}

const DEFAULT_CONFIG: ChatAgentConfig = {
  id: 'chat-agent',
  name: 'Chat Agent',
  modelId: 'gpt-4',
  systemPrompt: '你是一个 helpful 的 AI 助手，能够回答用户的各类问题。',
  maxContextMessages: 20,
};

export class ChatAgent extends BaseSessionAgent {
  private localSessionManager: IflowSessionManager;

  constructor(config: Partial<ChatAgentConfig> = {}) {
    super({ ...DEFAULT_CONFIG, ...config });
    this.localSessionManager = new IflowSessionManager();
  }

  protected async registerHandlers(hub: MessageHub): Promise<void> {
    // 初始化 session manager
    await this.localSessionManager.initialize();
    setGlobalSessionManager(this.localSessionManager);
    log.info('Session manager initialized');

    // 注册 input handler
    hub.registerInput('chat-agent', async (message: unknown) => {
      const msg = message as ChatInput & { sender?: { id: string } };
      try {
        const result = await this.handleChat(msg);
        return { success: true, result };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error('Chat handling failed', err);
        return {
          success: false,
          error: err.message,
          result: { success: false, error: err.message, sessionId: msg.sessionId || 'unknown' },
        };
      }
    });

    // 注册 output handler
    hub.registerOutput('chat-agent', async (message: unknown) => {
      const msg = message as ChatOutput;
      log.debug('Chat output', { sessionId: msg.sessionId, hasResponse: !!msg.response });
      return msg;
    });

    log.info('Chat Agent registered to Message Hub');
  }

  protected async handleMessage(input: unknown, _context: AgentContext): Promise<unknown> {
    const msg = input as ChatInput;
    return this.handleChat(msg);
  }

  private async handleChat(input: ChatInput): Promise<ChatOutput> {
    // 获取或创建 session
    let session: Session;

    if (input.createNewSession || !input.sessionId) {
      session = await this.localSessionManager.createSession({
        title: input.text.substring(0, 50) || '新对话',
        metadata: input.metadata,
      });
      log.info('Created new session', { sessionId: session.id });
    } else {
      const existing = await this.localSessionManager.getSession(input.sessionId);
      if (!existing) {
        session = await this.localSessionManager.createSession({
          title: input.text.substring(0, 50) || '新对话',
          metadata: input.metadata,
        });
        log.info('Session not found, created new', { oldSessionId: input.sessionId, newSessionId: session.id });
      } else {
        session = existing;
      }
    }

    // 添加用户消息到 session
    await this.localSessionManager.addMessage(session.id, {
      role: 'user',
      content: input.text,
      metadata: input.metadata,
    });

    // 获取上下文历史
    const history = await this.localSessionManager.getMessageHistory(
      session.id,
      this.config.maxContextMessages
    );

    // 调用 LLM 获取回复
    const response = await this.callLLM(input.text, this.config.systemPrompt, history);

    // 添加助手回复到 session
    const assistantMsg = await this.localSessionManager.addMessage(session.id, {
      role: 'assistant',
      content: response,
    });

    return {
      success: true,
      response,
      sessionId: session.id,
      messageId: assistantMsg.id,
    };
  }

  // 公开 API
  async createSession(title?: string): Promise<Session> {
    return this.localSessionManager.createSession({ title });
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.localSessionManager.getSession(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    return this.localSessionManager.querySessions({ status: SessionStatus.ACTIVE });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.localSessionManager.deleteSession(sessionId);
  }
}

// AgentModule 导出
export const chatAgent: AgentModule = {
  id: 'chat-agent',
  type: 'agent',
  name: 'chat-agent',
  version: '1.0.0',
  capabilities: ['chat', 'conversation', 'session-management'],

  initialize: async (hub: MessageHub): Promise<void> => {
    const agent = new ChatAgent();
    const sessionManager = new IflowSessionManager();
    await sessionManager.initialize();
    await agent.initializeHub(hub, sessionManager);
  },

  execute: async (command: string, _params?: Record<string, unknown>) => {
    switch (command) {
      case 'getConfig':
        return { config: DEFAULT_CONFIG };
      case 'listSessions':
        return { sessions: [] };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  },
};

export default chatAgent;
