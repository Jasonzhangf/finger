import { describe, it, expect } from 'vitest';
import { createMessage, type TaskAssignment } from '../../../src/agents/protocol/schema.js';

describe('Agent Protocol Schema', () => {
  it('creates a message with required fields', () => {
    const payload = {
      task: {
        taskId: 't1',
        description: 'Test task',
        tools: ['file'],
        priority: 1,
      } as TaskAssignment,
    };
    const msg = createMessage('orchestrator', 'executor', 'execute', payload);
    expect(msg.sender).toBe('orchestrator');
    expect(msg.status).toBe('pending');
  });

  it('includes ReACT elements in task', () => {
    const task: TaskAssignment = {
      taskId: 't1',
      thought: 'Need to break this down...',
      action: 'Create file',
      description: 'Test',
      tools: [],
      priority: 1,
    };
    expect(task.thought).toBeDefined();
    expect(task.action).toBeDefined();
  });
});
