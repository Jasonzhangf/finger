/**
 * Chat Agent - 通用对话 Agent（统一 I/O loop）
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';
import { IflowAgentBase, type IflowAgentBaseConfig } from '../base/iflow-agent-base.js';
import { IflowSessionManager } from './iflow-session-manager.js';
import type { UnifiedAgentInput, UnifiedAgentOutput } from '../base/unified-agent-types.js';

const log = logger.module('ChatAgent');

export type ChatAgentConfig = IflowAgentBaseConfig;
export type ChatInput = UnifiedAgentInput;
export type ChatOutput = UnifiedAgentOutput;

const DEFAULT_CONFIG: ChatAgentConfig = {
  id: 'chat-agent',
  name: 'Chat Agent',
  modelId: 'gpt-4',
  provider: 'iflow',
  systemPrompt: '你是一个 helpful 的 AI 助手，能够回答用户的各类问题。',
  maxContextMessages: 20,
};

export class ChatAgent extends IflowAgentBase {
  constructor(config: Partial<ChatAgentConfig> = {}) {
    super({ ...DEFAULT_CONFIG, ...config });
  }

  protected async registerHandlers(hub: MessageHub): Promise<void> {
    await this.prepareSessionManager();
    this.registerUnifiedHandlers(hub, this.config.id);
    log.info('Chat agent registered to Message Hub', { id: this.config.id });
  }
}

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
