import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import * as registry from '../../../src/agents/finger-system-agent/registry.js';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import * as heartbeatParser from '../../../src/server/modules/heartbeat-md-parser.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';
import { HeartbeatScheduler } from '../../../src/server/modules/heartbeat-scheduler.js';
import * as heartbeatHelpers from '../../../src/server/modules/heartbeat-helpers.js';
import { cleanupDispatchResultNotifications } from '../../../src/server/modules/heartbeat-helpers.js';

const SYSTEM_AGENT_ID = 'finger-system-agent';
const TASK_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-tasks.jsonl');

describe('HeartbeatScheduler mailbox lifecycle', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    heartbeatMailbox.removeAll(SYSTEM_AGENT_ID);
    await fs.mkdir(path.dirname(TASK_PATH), { recursive: true });
    await fs.writeFile(TASK_PATH, '', 'utf-8');
  });

  afterEach(async () => {
    heartbeatMailbox.removeAll(SYSTEM_AGENT_ID);
    await fs.writeFile(TASK_PATH, '', 'utf-8');
  });

  it('checks system agent mailbox even when registry has no project agents', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'catalog') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'idle' }] };
      }
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'completed' }] };
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

    const dispatchCall = execute.mock.calls.find((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall?.[1]).toEqual(expect.objectContaining({
      sourceAgentId: 'system-heartbeat',
      targetAgentId: SYSTEM_AGENT_ID,
      sessionId: expect.any(String),
      blocking: false,
      metadata: expect.objectContaining({
        taskId: 'mailbox-check',
        scheduledProgressDelivery: { mode: 'result_only' },
      }),
    }));
  });

  it('allows heartbeat dispatch progress policy override from task config', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'completed' }] };
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
      {
        type: 'heartbeat-task',
        taskId: 'mailbox-check',
        prompt: 'run mailbox check',
        progressDelivery: { mode: 'all' },
      },
      { category: 'heartbeat-task', priority: 1 },
    );

    await (scheduler as any).promptMailboxChecks();

    const dispatchCall = execute.mock.calls.find((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall?.[1]).toEqual(expect.objectContaining({
      metadata: expect.objectContaining({
        taskId: 'mailbox-check',
        scheduledProgressDelivery: { mode: 'all' },
      }),
    }));
  });

  it('dispatchDirect uses isolated heartbeat-control session (never business/system session)', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'completed' }] };
      }
      return { ok: true };
    });
    const ensureSession = vi.fn((sessionId: string) => ({ id: sessionId }));
    const updateContext = vi.fn(() => true);
    const getSession = vi.fn((sessionId: string) => {
      if (sessionId === 'hb-session-finger-system-agent-global') {
        return { id: sessionId, context: { sessionTier: 'heartbeat-control' } };
      }
      if (sessionId === 'system-main') {
        return { id: sessionId, context: { sessionTier: 'system' } };
      }
      return null;
    });

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        ensureSession,
        updateContext,
        getSession,
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);

    const ok = await (scheduler as any).dispatchDirect(
      SYSTEM_AGENT_ID,
      'hb-check',
      undefined,
      'heartbeat prompt',
      { progressDelivery: { mode: 'silent' } },
      'system-main',
    );

    expect(ok).toBe(true);
    expect(ensureSession).toHaveBeenCalledWith(
      'hb-session-finger-system-agent-global',
      expect.any(String),
      '[hb] finger-system-agent',
    );
    expect(updateContext).toHaveBeenCalledWith(
      'hb-session-finger-system-agent-global',
      expect.objectContaining({
        sessionTier: 'heartbeat-control',
        controlPath: 'heartbeat',
        userInputAllowed: false,
      }),
    );
    const dispatchCall = execute.mock.calls.find((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall?.[1]).toEqual(expect.objectContaining({
      targetAgentId: SYSTEM_AGENT_ID,
      sessionId: 'hb-session-finger-system-agent-global',
    }));
  });

  it('uses 5-minute mailbox prompt interval when agent stays idle', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'catalog') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'idle' }] };
      }
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'completed' }] };
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

  it('defers mailbox-check dispatch when registry/runtime reports busy', async () => {
    const listAgentsMock = vi.spyOn(registry, 'listAgents');
    let runtimeStatus: 'busy' | 'idle' = 'busy';
    listAgentsMock.mockImplementation(async () => ([
      {
        agentId: SYSTEM_AGENT_ID,
        status: runtimeStatus,
      } as any,
    ]));
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: runtimeStatus === 'busy' ? 'running' : 'completed' }] };
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
      { type: 'dispatch-task', taskId: 'task-defer', prompt: 'run mailbox check' },
      { category: 'dispatch-task', priority: 1 },
    );

    // force "due now": busy status should defer mailbox-check dispatch (no direct dispatch while busy)
    (scheduler as any).lastMailboxPromptAt.set(SYSTEM_AGENT_ID, Date.now() - 6 * 60_000);
    await (scheduler as any).promptMailboxChecks();
    expect(execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch')).toHaveLength(0);
    expect((scheduler as any).mailboxPromptDeferredByAgent.has(SYSTEM_AGENT_ID)).toBe(true);

    // once idle, deferred mailbox-check should dispatch immediately
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
      { dispatch: 'mailbox', prompt: 'run mailbox check' },
    );
    await (scheduler as any).dispatchTask(
      SYSTEM_AGENT_ID,
      'global',
      undefined,
      { dispatch: 'mailbox', prompt: 'run mailbox check' },
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
      'finger-project-agent',
      'project:project-monitored',
      'project-monitored',
      expect.objectContaining({ enabled: true }),
      undefined,
    );
  });

  it('selects project-agent owned session for project heartbeat (avoids system-session pollution)', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: '/repo/monitored',
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
    ]);

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute: vi.fn(async () => ({ ok: true })) },
      sessionManager: {
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-test' })),
        findSessionsByProjectPath: vi.fn(() => ([
          {
            id: 'session-system-owner',
            projectPath: '/repo/monitored',
            lastAccessedAt: '2026-04-02T08:40:00.000+08:00',
            context: { ownerAgentId: 'finger-system-agent', sessionTier: 'system' },
          },
          {
            id: 'session-project-worker',
            projectPath: '/repo/monitored',
            lastAccessedAt: '2026-04-02T08:39:00.000+08:00',
            context: { ownerAgentId: 'finger-project-agent', sessionTier: 'main' },
          },
        ])),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);

    (scheduler as any).config = {
      global: { enabled: false },
      projects: {
        'project-monitored': { enabled: true, intervalMs: 1000 },
      },
    };

    vi.spyOn(scheduler as any, 'runExecutionWatchdog').mockResolvedValue(undefined);
    const dispatchTaskSpy = vi.spyOn(scheduler as any, 'dispatchTask').mockResolvedValue(undefined);

    await (scheduler as any).dispatchDueTasks();

    expect(dispatchTaskSpy).toHaveBeenCalledTimes(1);
    expect(dispatchTaskSpy).toHaveBeenCalledWith(
      'finger-project-agent',
      'project:project-monitored',
      'project-monitored',
      expect.objectContaining({ enabled: true }),
      'session-project-worker',
    );
  });

  it('dispatches global heartbeat prompt from pending task list on direct mode', async () => {
    vi.spyOn(heartbeatParser, 'resolveHeartbeatMdPath').mockReturnValue(null);
    await fs.writeFile(
      TASK_PATH,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        type: 'heartbeat_task',
        action: 'add',
        task: { text: '检查系统 HEARTBEAT 默认流程', status: 'pending' },
      })}\n`,
      'utf-8',
    );
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return { agents: [{ id: SYSTEM_AGENT_ID, status: 'completed' }] };
      }
      return { ok: true };
    });
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
        task: expect.stringContaining('检查系统 HEARTBEAT 默认流程'),
      }),
    );
  });

  it('skips generic project heartbeat dispatch when no explicit project prompt is configured', async () => {
    vi.spyOn(heartbeatHelpers, 'resolveProjectPath').mockResolvedValue('/repo/project-a');
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return { agents: [{ id: 'finger-project-agent', status: 'completed' }] };
      }
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getSession: vi.fn(() => ({ id: 'session-project-a', context: {} })),
      },
    } as any);

    await (scheduler as any).dispatchTask(
      'finger-project-agent',
      'project:project-a',
      'project-a',
      { dispatch: 'dispatch' },
      'session-project-a',
    );

    expect(execute).not.toHaveBeenCalledWith('dispatch', expect.anything());
  });

  it('auto-closes stale dispatch_suppressed projectTaskState after completed stop lifecycle', async () => {
    const sessionManager = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== 'session-project-a') return null;
        return {
          id: sessionId,
          projectPath: '/tmp/project-a',
          context: {
            executionLifecycle: {
              stage: 'completed',
              finishReason: 'stop',
              startedAt: '2026-03-31T00:00:00.000Z',
              lastTransitionAt: '2026-03-31T00:10:00.000Z',
              retryCount: 0,
            },
            projectTaskState: {
              active: true,
              status: 'in_progress',
              sourceAgentId: 'finger-system-agent',
              targetAgentId: 'finger-project-agent',
              updatedAt: '2026-03-31T00:00:00.000Z',
              taskId: 'task-a',
              taskName: 'watch-task',
              note: 'dispatch_suppressed_target_busy',
            },
          },
        };
      }),
      updateContext: vi.fn(),
    };
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute: vi.fn(async () => ({ ok: true })) },
      sessionManager,
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    const dispatchDirectSpy = vi.spyOn(scheduler as any, 'dispatchDirect').mockResolvedValue(false);

    await (scheduler as any).runExecutionWatchdog(
      'finger-project-agent',
      'project-a',
      'session-project-a',
    );

    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      'session-project-a',
      expect.objectContaining({
        projectTaskState: null,
      }),
    );
    expect(dispatchDirectSpy).not.toHaveBeenCalled();
  });

  it('resumes watchdog when lifecycle is turn_stop_tool_pending with finish_reason=stop', async () => {
    vi.spyOn(heartbeatHelpers, 'resolveProjectPath').mockResolvedValue('/repo/project-a');
    const sessionManager = {
      getSession: vi.fn((sessionId: string) => {
        if (sessionId !== 'session-project-a') return null;
        return {
          id: sessionId,
          context: {
            executionLifecycle: {
              stage: 'interrupted',
              substage: 'turn_stop_tool_pending',
              finishReason: 'stop',
              startedAt: '2026-03-31T00:00:00.000Z',
              lastTransitionAt: '2026-03-31T00:10:00.000Z',
              retryCount: 0,
            },
          },
        };
      }),
      updateContext: vi.fn(),
    };
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute: vi.fn(async () => ({ ok: true })) },
      sessionManager,
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    const dispatchDirectSpy = vi.spyOn(scheduler as any, 'dispatchDirect').mockResolvedValue(undefined);

    await (scheduler as any).runExecutionWatchdog(
      'finger-project-agent',
      'project-a',
      'session-project-a',
    );

    expect(dispatchDirectSpy).toHaveBeenCalledTimes(1);
    expect(dispatchDirectSpy).toHaveBeenCalledWith(
      'finger-project-agent',
      expect.stringContaining('watchdog:lifecycle_resume'),
      'project-a',
      expect.stringContaining('检测到上一轮执行未 finish_reason=stop'),
      expect.any(Object),
      'session-project-a',
    );
  });
});
