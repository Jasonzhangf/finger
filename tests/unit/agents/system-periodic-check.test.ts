import { describe, expect, it, vi } from 'vitest';

import { PeriodicCheckRunner } from '../../../src/agents/finger-system-agent/periodic-check.js';

vi.mock('../../../src/agents/finger-system-agent/registry.js', () => ({
  listAgents: async () => [
    {
      projectId: 'proj-1',
      projectPath: '/tmp/proj-1',
      projectName: 'Project 1',
      agentId: 'agent-1',
      status: 'idle',
      lastHeartbeat: new Date().toISOString(),
      stats: { tasksCompleted: 0, tasksFailed: 0, uptime: 0 },
      monitored: true,
    },
  ],
  updateAgentStatus: vi.fn(),
  updateHeartbeat: vi.fn(),
}));

vi.mock('../../../src/agents/finger-system-agent/system-events.js', () => ({
  emitAgentStatusChanged: vi.fn(),
}));

vi.mock('../../../src/runtime/session-control-plane.js', () => ({
  SessionControlPlaneStore: class {
    list(opts?: any) {
      return [{ fingerSessionId: 'session-1', agentId: opts?.agentId ?? 'agent-1' }];
    }
  },
}));

describe('PeriodicCheckRunner', () => {
  it('dispatches heartbeat to idle agents', async () => {
    const dispatchMock = vi.fn();
    const deps = {
      agentRuntimeBlock: {
        execute: async (command: string) => {
          if (command === 'runtime_view') {
            return { agents: [{ id: 'agent-1', status: 'idle' }] };
          }
          if (command === 'dispatch') {
            dispatchMock();
          }
          return {};
        },
      },
    } as any;

    const runner = new PeriodicCheckRunner(deps);
    await runner.runOnce();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });
});
