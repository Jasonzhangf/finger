import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../../src/agents/finger-system-agent/registry.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';
import { HeartbeatScheduler } from '../../../src/server/modules/heartbeat-scheduler.js';

const SYSTEM_AGENT_ID = 'finger-system-agent';

describe('HeartbeatScheduler mailbox lifecycle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    heartbeatMailbox.removeAll(SYSTEM_AGENT_ID);
  });

  afterEach(() => {
    heartbeatMailbox.removeAll(SYSTEM_AGENT_ID);
  });

  it('checks system agent mailbox even when registry has no project agents', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'heartbeat-task', taskId: 'task-1', prompt: 'run mailbox check' },
      { category: 'heartbeat-task', priority: 1 },
    );

    await (scheduler as any).promptMailboxChecks();

    expect(execute).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        sourceAgentId: 'system-heartbeat',
        targetAgentId: SYSTEM_AGENT_ID,
        sessionId: expect.any(String),
        blocking: false,
        metadata: expect.objectContaining({
          taskId: 'mailbox-check',
        }),
      }),
    );
  });

  it('auto-cleans dispatch-result notifications regardless of read state', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'dispatch-result', dispatchId: 'dispatch-1', summary: 'done-1' },
      { category: 'notification', priority: 2 },
    );
    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'dispatch-result', dispatchId: 'dispatch-2', summary: 'done-2' },
      { category: 'notification', priority: 2 },
    );
    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'heartbeat-task', taskId: 'task-2', prompt: 'still actionable' },
      { category: 'heartbeat-task', priority: 1 },
    );

    await (scheduler as any).promptMailboxChecks();

    expect(heartbeatMailbox.list(SYSTEM_AGENT_ID, { category: 'notification' })).toHaveLength(0);
    expect(heartbeatMailbox.list(SYSTEM_AGENT_ID, { category: 'heartbeat-task' })).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
