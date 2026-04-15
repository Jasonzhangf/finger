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
        execute: async (command: string, payload?: Record<string, unknown>) => {
          if (command === 'runtime_view') {
            return {
              agents: [{ id: 'agent-1', status: 'idle' }],
              instances: [{
                id: 'deployment-agent-1',
                agentId: 'agent-1',
                name: 'Agent 1',
                type: 'project',
                status: 'idle',
                sessionId: 'hb-session-agent-1-tmp-proj-1',
                source: 'deployment',
                deploymentId: 'deployment-agent-1',
                createdAt: new Date().toISOString(),
              }],
            };
          }
          if (command === 'dispatch') {
            dispatchMock(payload);
          }
          return {};
        },
      },
    } as any;

    const runner = new PeriodicCheckRunner(deps);
    await runner.runOnce();

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      queueOnBusy: false,
      maxQueueWaitMs: 0,
      blocking: false,
      metadata: expect.objectContaining({
        source: 'system-heartbeat',
        role: 'system',
        deliveryMode: 'direct',
      }),
    }));
    const payload = dispatchMock.mock.calls[0]?.[0] as { metadata?: Record<string, unknown> } | undefined;
    expect(payload?.metadata?.systemDirectInject).toBeUndefined();
  });
});
