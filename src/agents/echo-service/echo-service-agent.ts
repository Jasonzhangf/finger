/**
 * Echo Service Agent - 双向消息代理
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';

interface EchoMessage {
  type: string;
  text?: string;
  data?: unknown;
  replyTo?: string;
  correlationId?: string;
}

export class EchoServiceAgent {
  private log = logger.module('EchoService');

  initialize(hub: MessageHub): void {
    hub.registerInput('echo-service-input', async (message: unknown) => {
      const msg = message as EchoMessage;
      this.log.info('Received message', { type: msg.type, text: msg.text });

      const reply = {
        type: 'echo.reply',
        originalType: msg.type,
        text: msg.text ? `Echo: ${msg.text}` : undefined,
        timestamp: new Date().toISOString(),
        processed: true,
      };

      if (msg.replyTo) {
        await hub.routeToOutput(msg.replyTo, {
          ...reply,
          correlationId: msg.correlationId,
        });
      }

      return reply;
    });

    hub.registerOutput('echo-service-output', async (message: unknown) => {
      const msg = message as EchoMessage;
      this.log.info('Output handler called', { type: msg.type });
      return {
        success: true,
        messageId: `echo-${Date.now()}`,
        data: msg,
      };
    });

    hub.addRoute({
      pattern: 'echo.message',
      handler: async (msg: unknown) => {
        const m = msg as EchoMessage;
        return {
          type: 'echo.reply',
          originalType: m.type,
          text: m.text ? `Echo: ${m.text}` : undefined,
          timestamp: new Date().toISOString(),
        };
      },
      blocking: false,
      priority: 100,
      moduleId: 'echo-service',
    });

    this.log.info('EchoService initialized');
  }
}

export const echoServiceAgent: AgentModule = {
  id: 'echo-service-agent',
  type: 'agent',
  name: 'echo-service-agent',
  version: '1.0.0',
  capabilities: ['echo', 'reply', 'bidirectional'],

  initialize: async (hub: MessageHub): Promise<void> => {
    const agent = new EchoServiceAgent();
    agent.initialize(hub);
  },

  execute: async (command: string, params: unknown) => {
    if (command === 'echo') {
      return {
        type: 'echo.reply',
        data: params,
        timestamp: new Date().toISOString(),
      };
    }
    throw new Error(`Unknown command: ${command}`);
  },
};

export default echoServiceAgent;
