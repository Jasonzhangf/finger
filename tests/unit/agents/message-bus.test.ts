import { describe, it, expect, beforeEach } from 'vitest';
import { EventBusBlock } from '../../../src/blocks/eventbus-block/index.js';
import { MessageBus } from '../../../src/agents/runtime/message-bus.js';
import { createMessage, type TaskAssignment, type AgentMessage } from '../../../src/agents/protocol/schema.js';

describe('MessageBus', () => {
  let eventBus: EventBusBlock;
  let bus: MessageBus;

  beforeEach(() => {
    eventBus = new EventBusBlock('test-eventbus');
    bus = new MessageBus(eventBus);
  });

  it('sends a message via EventBus', async () => {
    const task: TaskAssignment = {
      taskId: 't1',
      description: 'Test',
      tools: ['file'],
      priority: 1,
    };
    const msg = createMessage('orchestrator', 'executor', 'execute', { task });
    await bus.send(msg);
    const history = bus.getHistory('executor');
    expect(history).toHaveLength(1);
    expect(history[0].sender).toBe('orchestrator');
  });

  it('subscribes to messages for specific agent', async () => {
    const received: AgentMessage[] = [];
    bus.subscribe('executor', (m) => received.push(m));

    const task: TaskAssignment = {
      taskId: 't1',
      description: 'Test',
      tools: [],
      priority: 1,
    };
    const msg = createMessage('orchestrator', 'executor', 'execute', { task });
    await bus.send(msg);

    expect(received).toHaveLength(1);
  });
});
