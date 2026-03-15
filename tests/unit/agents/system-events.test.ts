import { describe, expect, it, vi } from 'vitest';

import { emitAgentStatusChanged, emitTaskCompleted } from '../../../src/agents/finger-system-agent/system-events.js';

describe('system-events', () => {
  it('emits agent status changed', () => {
    const broadcast = vi.fn();
    emitAgentStatusChanged({ broadcast } as any, { agentId: 'agent-1', status: 'idle', projectId: 'proj-1' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const event = broadcast.mock.calls[0][0];
    expect(event.type).toBe('system_notice');
    expect(event.payload.event).toBe('agent_status_changed');
  });

  it('emits task completed', () => {
    const broadcast = vi.fn();
    emitTaskCompleted({ broadcast } as any, { taskId: 'task-1', projectId: 'proj-1' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const event = broadcast.mock.calls[0][0];
    expect(event.type).toBe('system_notice');
    expect(event.payload.event).toBe('task_completed');
  });
});
