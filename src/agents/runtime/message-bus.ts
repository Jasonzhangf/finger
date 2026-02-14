import { EventBusBlock } from '../../blocks/eventbus-block/index.js';
import type { AgentMessage } from '../protocol/schema.js';

export class MessageBus {
  private eventBus: EventBusBlock;

  constructor(eventBus: EventBusBlock) {
    this.eventBus = eventBus;
  }

  async send(message: AgentMessage): Promise<void> {
    await this.eventBus.emit({
      type: 'agent.message',
      payload: message,
      source: message.sender,
    });
  }

  subscribe(agentId: string, handler: (msg: AgentMessage) => void): { unsubscribe: () => void } {
    const subscription = this.eventBus.subscribe('agent.message', (event) => {
      const msg = event.payload as AgentMessage;
      if (msg.receiver === agentId) {
        handler(msg);
      }
    });
    return { unsubscribe: () => subscription };
  }

  getHistory(agentId?: string): AgentMessage[] {
    const events = this.eventBus.getHistory('agent.message');
    const messages = events.map(e => e.payload as AgentMessage);
    if (agentId) {
      return messages.filter(m => m.receiver === agentId || m.sender === agentId);
    }
    return messages;
  }
}
