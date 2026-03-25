import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../../src/agents/finger-system-agent/registry.js';
import { SYSTEM_PROJECT_PATH } from '../../../src/agents/finger-system-agent/index.js';
import * as heartbeatParser from '../../../src/server/modules/heartbeat-md-parser.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';
import { HeartbeatScheduler } from '../../../src/server/modules/heartbeat-scheduler.js';
import { cleanupDispatchResultNotifications } from '../../../src/server/modules/heartbeat-helpers.js';

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
    const execute = vi.fn(async (command: string) => {
      if (command === 'catalog') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'idle' }] };
      }
      return { ok: true };
    });
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

  it('uses 5-minute mailbox prompt interval when agent stays idle', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'catalog') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'idle' }] };
      }
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'heartbeat-task', taskId: 'task-throttle', prompt: 'run mailbox check' },
      { category: 'heartbeat-task', priority: 1 },
    );

    await (scheduler as any).promptMailboxChecks();
    const firstDispatchCount = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch').length;
    expect(firstDispatchCount).toBe(1);

    // second check happens immediately: should be throttled by 5-minute interval
    await (scheduler as any).promptMailboxChecks();
    const secondDispatchCount = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch').length;
    expect(secondDispatchCount).toBe(1);
  });

  it('defers mailbox prompt while busy and prompts immediately after idle', async () => {
    const listAgentsMock = vi.spyOn(registry, 'listAgents');
    let runtimeStatus: 'busy' | 'idle' = 'busy';
    listAgentsMock.mockImplementation(async () => ([
      {
        agentId: SYSTEM_AGENT_ID,
        status: runtimeStatus,
      } as any,
    ]));
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'dispatch-task', taskId: 'task-defer', prompt: 'run mailbox check' },
      { category: 'dispatch-task', priority: 1 },
    );

    // force "due now" so busy state should mark deferred prompt
    (scheduler as any).lastMailboxPromptAt.set(SYSTEM_AGENT_ID, Date.now() - 6 * 60_000);
    await (scheduler as any).promptMailboxChecks();
    expect(execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch')).toHaveLength(0);
    expect((scheduler as any).mailboxPromptDeferredByAgent.has(SYSTEM_AGENT_ID)).toBe(true);

    // once idle, the deferred prompt should fire immediately (without waiting another 5 min)
    runtimeStatus = 'idle';
    await (scheduler as any).promptMailboxChecks();
    expect(execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch')).toHaveLength(1);
    expect((scheduler as any).mailboxPromptDeferredByAgent.has(SYSTEM_AGENT_ID)).toBe(false);
  });

  it('cleans dispatch-result notifications before mailbox prompt composition', async () => {
    const execute = vi.fn(async () => ({ agents: [] }));
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
    void scheduler;
    const result = cleanupDispatchResultNotifications(SYSTEM_AGENT_ID);
    expect(result.removed).toBe(2);
    expect(heartbeatMailbox.list(SYSTEM_AGENT_ID, { category: 'notification' })).toHaveLength(0);
  });

  it('does not dispatch mailbox-check when cleanup removed all pending notifications', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      { agentId: SYSTEM_AGENT_ID, status: 'idle' } as any,
    ]);
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    heartbeatMailbox.append(
      SYSTEM_AGENT_ID,
      { type: 'dispatch-result', dispatchId: 'dispatch-cleanup-only', summary: 'done' },
      { category: 'notification', priority: 2 },
    );

    await (scheduler as any).promptMailboxChecks();
    expect(execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch')).toHaveLength(0);
    expect(heartbeatMailbox.listPending(SYSTEM_AGENT_ID)).toHaveLength(0);
  });

  it('does not append duplicate pending heartbeat-task for same task/project', async () => {
    vi.spyOn(heartbeatParser, 'resolveHeartbeatMdPath').mockReturnValue(undefined);
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'mailbox' },
    );
    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'mailbox' },
    );

    const pending = heartbeatMailbox.list(SYSTEM_AGENT_ID, {
      status: 'pending',
      category: 'heartbeat-task',
    });
    expect(pending).toHaveLength(1);
  });

  it('skips heartbeat dispatch when checklist has no unchecked tasks', async () => {
    vi.spyOn(heartbeatParser, 'resolveHeartbeatMdPath').mockReturnValue('/tmp/fake-heartbeat.md');
    vi.spyOn(heartbeatParser, 'validateHeartbeatMd').mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      canAutoRepair: false,
    });
    vi.spyOn(heartbeatParser, 'shouldStopHeartbeat').mockResolvedValue({
      shouldStop: false,
      checklistStats: {
        total: 3,
        checked: 3,
        unchecked: 0,
      },
    });

    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'mailbox' },
    );

    const pending = heartbeatMailbox.list(SYSTEM_AGENT_ID, {
      status: 'pending',
      category: 'heartbeat-task',
    });
    expect(pending).toHaveLength(0);
  });

  it('skips heartbeat dispatch when checklist is empty (no actionable tasks)', async () => {
    vi.spyOn(heartbeatParser, 'resolveHeartbeatMdPath').mockReturnValue('/tmp/fake-heartbeat-empty.md');
    vi.spyOn(heartbeatParser, 'validateHeartbeatMd').mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      canAutoRepair: false,
    });
    vi.spyOn(heartbeatParser, 'shouldStopHeartbeat').mockResolvedValue({
      shouldStop: false,
      checklistStats: {
        total: 0,
        checked: 0,
        unchecked: 0,
      },
    });

    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'mailbox' },
    );

    const pending = heartbeatMailbox.list(SYSTEM_AGENT_ID, {
      status: 'pending',
      category: 'heartbeat-task',
    });
    expect(pending).toHaveLength(0);
    expect(execute).not.toHaveBeenCalledWith('dispatch', expect.anything());
  });

  it('dispatches project heartbeat only for monitored registry entries', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: '/repo/monitored',
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
      {
        projectId: 'project-unmonitored',
        projectPath: '/repo/unmonitored',
        monitored: false,
        agentId: 'project-unmonitored-agent',
        status: 'idle',
      } as any,
    ]);

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute: vi.fn(async () => ({ ok: true })) },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    (scheduler as any).config = {
      global: { enabled: false },
      projects: {
        'project-monitored': { enabled: true, intervalMs: 1000 },
        'project-unmonitored': { enabled: true, intervalMs: 1000 },
      },
    };

    const dispatchTaskSpy = vi.spyOn(scheduler as any, 'dispatchTask').mockResolvedValue(undefined);
    await (scheduler as any).dispatchDueTasks();

    expect(dispatchTaskSpy).toHaveBeenCalledTimes(1);
    expect(dispatchTaskSpy).toHaveBeenCalledWith(
      'project-monitored-agent',
      'project:project-monitored',
      'project-monitored',
      expect.objectContaining({ enabled: true }),
    );
  });

  it('uses explicit system path in global heartbeat default prompt', async () => {
    vi.spyOn(heartbeatParser, 'resolveHeartbeatMdPath').mockReturnValue(null);
    const execute = vi.fn(async () => ({ ok: true }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
      },
    } as any);

    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'dispatch' },
    );

    expect(execute).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({
        targetAgentId: SYSTEM_AGENT_ID,
        task: expect.stringContaining(`系统路径: ${SYSTEM_PROJECT_PATH}`),
      }),
    );

    const dispatchedTask = execute.mock.calls.find((call: unknown[]) => call[0] === 'dispatch')?.[1]?.task;
    expect(String(dispatchedTask)).not.toContain('请检查项目根目录的 HEARTBEAT.md');
  });
});
