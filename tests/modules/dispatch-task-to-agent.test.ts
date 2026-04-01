import { describe, it, expect, vi, beforeEach } from 'vitest';

const { setMonitorStatusMock } = vi.hoisted(() => ({
  setMonitorStatusMock: vi.fn(async (projectPath: string, enabled: boolean) => ({
    projectId: 'project-test',
    projectPath,
    projectName: 'project-test',
    agentId: 'project-test-agent',
    status: 'idle',
    lastHeartbeat: new Date().toISOString(),
    monitored: enabled,
    monitorUpdatedAt: new Date().toISOString(),
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      uptime: 0,
    },
  })),
}));

vi.mock('../../src/agents/finger-system-agent/registry.js', () => ({
  setMonitorStatus: setMonitorStatusMock,
}));

function createDeps(executeImpl?: ReturnType<typeof vi.fn>) {
  const calls: Array<{ sessionId: string; role: string; content: string; type?: string }> = [];
  const rootSessions = [
    { id: 'root-session-1', context: {}, projectPath: '/tmp/project-a', messages: [], lastAccessedAt: '2026-03-24T00:00:00.000Z' },
    { id: 'root-session-2', context: {}, projectPath: '/tmp/project-a', messages: [], lastAccessedAt: '2026-03-24T00:10:00.000Z' },
  ];
  const sessionProjectPathById: Record<string, string> = {
    'root-session-1': '/tmp/project-a',
    'root-session-2': '/tmp/project-a',
    'child-session-1': '/tmp/project-a',
    'new-session-project-a': '/tmp/project-a',
    'new-session-project-b': '/tmp/project-b',
    'runtime-current': '/tmp/runtime-current',
    'session-manager-current': '/tmp/session-manager-current',
  };
  const runtimeCurrentSession = { id: 'runtime-current', projectPath: '/tmp/runtime-current' };
  const sessionManager = {
    addMessage: vi.fn(async (sessionId: string, role: string, content: string, detail?: Record<string, unknown>) => {
      calls.push({ sessionId, role, content, type: (detail as any)?.type });
      return { id: 'msg', role, content, timestamp: new Date().toISOString() };
    }),
    getMessages: vi.fn(() => calls),
    getSession: vi.fn((id: string) => ({
      id,
      context: {},
      projectPath: sessionProjectPathById[id] ?? '/tmp',
      messages: [],
    })),
    getCurrentSession: vi.fn(() => ({ id: 'session-manager-current', projectPath: '/tmp/session-manager-current' })),
    findSessionsByProjectPath: vi.fn((projectPath: string) => rootSessions.filter((item) => item.projectPath === projectPath)),
    createSession: vi.fn((projectPath: string) => ({ id: `new-session-${projectPath.split('/').pop()}`, context: {}, projectPath, messages: [] })),
    setCurrentSession: vi.fn(() => true),
    updateContext: vi.fn(() => true),
    getOrCreateSystemSession: vi.fn(() => ({ id: 'system-session-root' })),
  };

  return {
    deps: {
      runtime: {
        getCurrentSession: vi.fn(() => runtimeCurrentSession),
        bindAgentSession: vi.fn(),
        getBoundSessionId: vi.fn(() => null),
        setCurrentSession: vi.fn(),
      },
      sessionManager,
      agentRuntimeBlock: {
        execute: executeImpl ?? vi.fn(async () => ({
          ok: true,
          dispatchId: 'dispatch-1',
          status: 'completed',
          result: { summary: 'ok' },
        })),
      },
      primaryOrchestratorAgentId: 'finger-orchestrator',
      isRuntimeChildSession: vi.fn(() => false),
      isPrimaryOrchestratorTarget: vi.fn(() => false),
      ensureRuntimeChildSession: vi.fn(() => ({ id: 'child-session-1', projectPath: '/tmp/project-a' })),
      ensureOrchestratorRootSession: vi.fn(() => ({
        id: 'root-session-1',
        projectPath: '/tmp/project-a',
        sessionWorkspaceRoot: '/tmp/ws',
        memoryDir: '/tmp/memory',
        deliverablesDir: '/tmp/deliverables',
        exchangeDir: '/tmp/exchange',
      })),
      sessionWorkspaces: {
        resolveSessionWorkspaceDirsForMessage: vi.fn(() => ({
          memoryDir: '/tmp/memory',
          deliverablesDir: '/tmp/deliverables',
          exchangeDir: '/tmp/exchange',
        })),
        hydrateSessionWorkspace: vi.fn((sessionId: any) => ({
          id: typeof sessionId === 'string' ? sessionId : String(sessionId?.id ?? ''),
          projectPath: '/tmp/project-a',
          sessionWorkspaceRoot: '/tmp/ws',
          memoryDir: '/tmp/memory',
          deliverablesDir: '/tmp/deliverables',
          exchangeDir: '/tmp/exchange',
        })),
      },
      bdTools: { assignTask: vi.fn(), addComment: vi.fn(), updateStatus: vi.fn() },
    },
    sessionCalls: calls,
    sessionManager,
    runtimeCurrentSession,
  };
}

describe('dispatchTaskToAgent', () => {
  let mod: typeof import('../../src/server/modules/agent-runtime/dispatch.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    setMonitorStatusMock.mockImplementation(async (projectPath: string, enabled: boolean) => ({
      projectId: 'project-test',
      projectPath,
      projectName: 'project-test',
      agentId: 'project-test-agent',
      status: 'idle',
      lastHeartbeat: new Date().toISOString(),
      monitored: enabled,
      monitorUpdatedAt: new Date().toISOString(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        uptime: 0,
      },
    }));
    process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES = '0';
    mod = await import('../../src/server/modules/agent-runtime/dispatch.js');
  });

  it('returns completed result and records dispatch user message', async () => {
    const { deps, sessionCalls, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run test',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(sessionCalls.some((c) => c.role === 'user' && c.content === 'run test' && c.type === 'dispatch')).toBe(true);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'completed',
        dispatchId: 'dispatch-1',
        updatedBy: 'dispatch',
        targetAgentId: 'finger-coder',
      }),
    }));
  });

  it('fails fast on self-dispatch and does not call runtime dispatch', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-system-agent',
      task: 'self dispatch should fail',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('self-dispatch forbidden');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        substage: 'dispatch_self_forbidden',
        updatedBy: 'dispatch',
        targetAgentId: 'finger-system-agent',
      }),
    }));
  });

  it('normalizes orchestrator gateway alias and dispatches to project agent', async () => {
    const { deps } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-orchestrator-gateway',
      task: 'alias target',
      sessionId: 'session-1',
      assignment: {
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect((deps as any).agentRuntimeBlock.execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
    }));
  });

  it('fails fast for invalid gateway module target and skips runtime dispatch', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'custom-gateway',
      task: 'invalid target',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('gateway module id is not dispatchable');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        substage: 'dispatch_target_invalid',
      }),
    }));
  });

  it('returns failed result when execute throws', async () => {
    const { deps, sessionManager } = createDeps(vi.fn(async () => { throw new Error('provider timeout'); }));
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('provider timeout');
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        substage: 'dispatch_execute_final_error',
        updatedBy: 'dispatch',
        targetAgentId: 'finger-coder',
      }),
    }));
  });

  it('passes through failed dispatch result', async () => {
    const { deps, sessionManager } = createDeps(
      vi.fn(async () => ({ ok: false, dispatchId: 'dispatch-fail', status: 'failed', error: 'target busy' })),
    );
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('target busy');
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        dispatchId: 'dispatch-fail',
        lastError: 'target busy',
      }),
    }));
  });

  it('auto deploys and retries when system dispatch target is not started', async () => {
    vi.resetModules();
    process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES = '1';
    const modWithRetry = await import('../../src/server/modules/agent-runtime/dispatch.js');
    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch' && execute.mock.calls.filter((c) => c[0] === 'dispatch').length === 1) {
        return {
          ok: false,
          dispatchId: 'dispatch-not-started',
          status: 'failed',
          error: 'target agent is not started in resource pool: finger-project-agent',
        };
      }
      if (command === 'deploy') {
        return { success: true };
      }
      return {
        ok: true,
        dispatchId: 'dispatch-retry-ok',
        status: 'completed',
        result: { summary: 'retry ok' },
      };
    });
    const { deps } = createDeps(execute);

    const res = await modWithRetry.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionId: 'session-1',
      assignment: {
        blocked_by: ['none'],
      },
      metadata: { instanceCount: 2 },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('deploy', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      instanceCount: 2,
    }));
    expect(execute.mock.calls.filter((c) => c[0] === 'dispatch')).toHaveLength(2);
  });

  it('resolves latest project session when sessionStrategy=latest', async () => {
    const { deps, sessionManager } = createDeps();
    const execute = (deps as any).agentRuntimeBlock.execute as ReturnType<typeof vi.fn>;
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
      assignment: {
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.findSessionsByProjectPath).toHaveBeenCalledWith('/tmp/project-a');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({ sessionId: 'root-session-2' }));
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('defaults to latest existing session when no session/sessionStrategy is provided', async () => {
    const { deps, sessionManager } = createDeps();
    const execute = (deps as any).agentRuntimeBlock.execute as ReturnType<typeof vi.fn>;
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      projectPath: '/tmp/project-a',
      assignment: {
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.findSessionsByProjectPath).toHaveBeenCalledWith('/tmp/project-a');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({ sessionId: 'root-session-2' }));
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('creates a new root session when sessionStrategy=new', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionStrategy: 'new',
      projectPath: '/tmp/project-b',
      assignment: {
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.createSession).toHaveBeenCalledWith('/tmp/project-b', undefined, { allowReuse: false });
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('session-manager-current');
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('marks queued_mailbox dispatches as dispatch_mailbox_wait_ack in lifecycle', async () => {
    const { deps, sessionManager } = createDeps(
      vi.fn(async () => ({
        ok: true,
        dispatchId: 'dispatch-mailbox-1',
        status: 'queued',
        result: { summary: 'busy timeout -> mailbox', status: 'queued_mailbox', messageId: 'msg-mailbox-1' },
      })),
    );

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionId: 'session-1',
      assignment: {
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('queued');
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'dispatching',
        substage: 'dispatch_mailbox_wait_ack',
        dispatchId: 'dispatch-mailbox-1',
        recoveryAction: 'mailbox',
        delivery: 'mailbox',
      }),
    }));
  });

  it('fails fast when system->project dispatch omits blocked_by on new task creation', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: { prompt: 'new task without blocked_by' },
      assignment: {
        taskId: 'task-missing-blocked-by',
      },
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('assignment.blocked_by');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        substage: 'dispatch_blocked_by_invalid',
      }),
    }));
  });

  it('fails when blocked_by mixes none with concrete dependencies', async () => {
    const { deps } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: { prompt: 'invalid blocked_by mix' },
      assignment: {
        taskId: 'task-invalid-blocked-by-mix',
        blocked_by: ['none', 'dep-1'],
      },
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('cannot mix "none"');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
  });

  it('uses runtime child session only for reviewer target', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-reviewer',
      task: 'review this',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
    } as any);

    expect(res.ok).toBe(true);
    expect((deps as any).ensureRuntimeChildSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-session-2' }), 'finger-reviewer');
  });

  it('keeps system->project dispatch async (non-blocking) when project agent is busy', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            {
              id: 'finger-project-agent',
              status: 'running',
              lastEvent: {
                dispatchId: 'dispatch-active-1',
                taskId: 'task-active-1',
                summary: 'project task is executing',
              },
            },
          ],
        };
      }
      return {
        ok: true,
        dispatchId: 'dispatch-new',
        status: 'completed',
        result: { summary: 'runs in async queue mode' },
      };
    });
    const { deps, sessionCalls, sessionManager } = createDeps(execute);
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: {
        prompt: 'run weibo detail task',
      },
      assignment: {
        taskId: 'task-active-1',
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 0,
    }));
    expect(sessionCalls.some((entry) => entry.role === 'user' && entry.type === 'dispatch')).toBe(true);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        substage: 'dispatch_completed',
      }),
    }));
  });

  it('keeps system->project dispatch async when project session lifecycle is active', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            {
              id: 'finger-project-agent',
              status: 'idle',
              lastEvent: {
                dispatchId: 'dispatch-idle',
                taskId: 'task-idle',
              },
            },
          ],
        };
      }
      return {
        ok: true,
        dispatchId: 'dispatch-new',
        status: 'completed',
        result: { summary: 'still dispatch in async mode' },
      };
    });
    const { deps, sessionManager } = createDeps(execute);
    sessionManager.getSession.mockImplementation((id: string) => {
      if (id === 'session-1') {
        return {
          id,
          context: {
            executionLifecycle: {
              stage: 'running',
              substage: 'turn_start',
              startedAt: '2026-03-29T10:00:00.000Z',
              lastTransitionAt: '2026-03-29T10:01:00.000Z',
              retryCount: 0,
            },
          },
          projectPath: '/tmp/project-a',
          messages: [],
        };
      }
      return { id, context: {}, projectPath: '/tmp/project-a', messages: [] };
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: { prompt: 'dispatch again' },
      assignment: {
        taskId: 'task-idle',
        blocked_by: ['none'],
      },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 0,
    }));
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        substage: 'dispatch_completed',
      }),
    }));
  });

  it('syncs project task state to caller session when dispatch auto-selects latest project session', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: { prompt: 'sync state to caller session' },
      assignment: { taskId: 'task-sync-1', taskName: 'task-sync', blocked_by: ['none'] },
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('runtime-current', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        taskId: 'task-sync-1',
        targetAgentId: 'finger-project-agent',
      }),
    }));
  });

  it('keeps async dispatch for active source task context (no hard suppression)', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            {
              id: 'finger-project-agent',
              status: 'idle',
            },
          ],
        };
      }
      return {
        ok: true,
        dispatchId: 'dispatch-should-not-run',
        status: 'completed',
        result: { summary: 'still dispatched by async policy' },
      };
    });
    const { deps, sessionManager } = createDeps(execute);
    sessionManager.getSession.mockImplementation((id: string) => {
      if (id === 'runtime-current') {
        return {
          id,
          context: {
            projectTaskState: {
              active: true,
              status: 'in_progress',
              sourceAgentId: 'finger-system-agent',
              targetAgentId: 'finger-project-agent',
              updatedAt: new Date().toISOString(),
              taskId: 'task-active-source-1',
              taskName: 'task-active-source',
              dispatchId: 'dispatch-active-source-1',
            },
          },
          projectPath: '/tmp/system',
          messages: [],
        };
      }
      return {
        id,
        context: {},
        projectPath: '/tmp/project-a',
        messages: [],
      };
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
      task: { prompt: 'duplicate dispatch should be blocked' },
      assignment: { taskId: 'task-active-source-1', taskName: 'task-active-source' },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 0,
    }));
    expect(sessionManager.updateContext).toHaveBeenCalledWith('root-session-2', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        substage: 'dispatch_completed',
      }),
    }));
  });

  it('skips system-heartbeat -> project dispatch when task state is completed and non-actionable', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            { id: 'finger-project-agent', status: 'idle' },
          ],
        };
      }
      if (command === 'dispatch') {
        return {
          ok: true,
          dispatchId: 'dispatch-should-not-run',
          status: 'completed',
          result: { summary: 'should not run' },
        };
      }
      return { ok: true };
    });
    const { deps, sessionManager } = createDeps(execute);
    sessionManager.getSession.mockImplementation((id: string) => {
      if (id === 'session-1') {
        return {
          id,
          context: {
            projectTaskState: {
              active: false,
              status: 'completed',
              sourceAgentId: 'finger-system-agent',
              targetAgentId: 'finger-project-agent',
              updatedAt: new Date().toISOString(),
              taskId: 'task-completed-1',
              taskName: 'completed-task',
              dispatchId: 'dispatch-completed-1',
            },
            executionLifecycle: {
              stage: 'completed',
              finishReason: 'stop',
              lastTransitionAt: new Date().toISOString(),
            },
          },
          projectPath: '/tmp/project-a',
          messages: [],
        };
      }
      return {
        id,
        context: {},
        projectPath: '/tmp/project-a',
        messages: [],
      };
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'system-heartbeat',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: 'heartbeat watchdog prompt',
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(res.result?.status).toBe('skipped_no_actionable');
    expect(res.result?.autoClosedMonitor).toBe(true);
    expect(res.result?.closeReason).toBe('expired_no_actionable');
    expect(execute).not.toHaveBeenCalledWith('dispatch', expect.anything());
    expect(setMonitorStatusMock).toHaveBeenCalledWith('/tmp/project-a', false);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        substage: 'dispatch_heartbeat_no_actionable',
      }),
    }));
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        active: false,
        status: 'closed',
      }),
    }));
  });

  it('does not self-suppress fresh system->project dispatch after lifecycle normalization', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            { id: 'finger-project-agent', status: 'idle' },
          ],
        };
      }
      if (command === 'dispatch') {
        return {
          ok: true,
          dispatchId: 'dispatch-fresh-1',
          status: 'completed',
          result: { summary: 'ok' },
        };
      }
      return { ok: true };
    });
    const { deps, sessionManager } = createDeps(execute);
    const sessionContexts: Record<string, Record<string, unknown>> = {
      'session-1': {},
    };
    sessionManager.getSession.mockImplementation((id: string) => ({
      id,
      context: sessionContexts[id] ?? {},
      projectPath: '/tmp/project-a',
      messages: [],
    }));
    sessionManager.updateContext.mockImplementation((id: string, patch: Record<string, unknown>) => {
      const current = sessionContexts[id] ?? {};
      sessionContexts[id] = { ...current, ...patch };
      return true;
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
      task: { prompt: 'fresh dispatch' },
      assignment: { taskId: 'task-fresh-1', blocked_by: ['none'] },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-1',
    }));
    expect(sessionManager.updateContext).not.toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        substage: 'dispatch_suppressed_active_lifecycle',
      }),
    }));
  });

  it('persists task state to canonical system session and bound project session to prevent restart gaps', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            { id: 'finger-project-agent', status: 'idle' },
          ],
        };
      }
      if (command === 'dispatch') {
        return {
          ok: true,
          dispatchId: 'dispatch-continuity-1',
          status: 'queued',
          result: { summary: 'queued' },
        };
      }
      return { ok: true };
    });
    const { deps, sessionManager } = createDeps(execute);
    (deps as any).runtime.getBoundSessionId.mockImplementation((agentId: string) => (
      agentId === 'finger-project-agent' ? 'project-bound-session-1' : null
    ));
    sessionManager.getSession.mockImplementation((id: string) => ({
      id,
      context: {},
      projectPath: id.startsWith('system-') ? '/tmp/system' : '/tmp/project-a',
      messages: [],
    }));

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'root-session-2',
      task: { prompt: 'continuity check dispatch' },
      assignment: { taskId: 'task-continuity-1', taskName: 'continuity-check', blocked_by: ['none'] },
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('system-session-root', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        taskId: 'task-continuity-1',
      }),
    }));
    expect(sessionManager.updateContext).toHaveBeenCalledWith('project-bound-session-1', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        taskId: 'task-continuity-1',
      }),
    }));
  });

  it('rejects cross-project dispatch when explicit session does not belong to requested project', async () => {
    const { deps } = createDeps();
    const sessionManager = (deps as any).sessionManager;
    sessionManager.getSession.mockImplementation((id: string) => ({
      id,
      context: {},
      projectPath: '/tmp/project-a',
      messages: [],
    }));

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-project-a',
      projectPath: '/tmp/project-b',
      task: 'cross project should fail',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('dispatch session/project scope mismatch');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
  });

  it('allows async dispatch when active task identity differs', async () => {
    const { deps, sessionManager } = createDeps();
    sessionManager.getSession.mockImplementation((id: string) => {
      if (id === 'runtime-current') {
        return {
          id,
          context: {
            projectTaskState: {
              active: true,
              status: 'in_progress',
              sourceAgentId: 'finger-system-agent',
              targetAgentId: 'finger-project-agent',
              updatedAt: new Date().toISOString(),
              taskId: 'task-active-binding-1',
              taskName: 'active-binding-task',
              dispatchId: 'dispatch-binding-1',
            },
          },
          projectPath: '/tmp/project-a',
          messages: [],
        };
      }
      return {
        id,
        context: {},
        projectPath: '/tmp/project-a',
        messages: [],
      };
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
      task: { prompt: 'new different task should still dispatch async' },
      assignment: { taskId: 'task-new-binding-2', taskName: 'new-task', blocked_by: ['none'] },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect((deps as any).agentRuntimeBlock.execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 0,
    }));
  });

  it('allows async dispatch when active bound session differs from selected session', async () => {
    const { deps, sessionManager } = createDeps();
    sessionManager.getSession.mockImplementation((id: string) => {
      if (id === 'runtime-current') {
        return {
          id,
          context: {
            projectTaskState: {
              active: true,
              status: 'in_progress',
              sourceAgentId: 'finger-system-agent',
              targetAgentId: 'finger-project-agent',
              updatedAt: new Date().toISOString(),
              taskId: 'task-active-bound-1',
              taskName: 'active-bound-task',
              dispatchId: 'dispatch-bound-1',
              boundSessionId: 'runtime-current',
              revision: 2,
            },
          },
          projectPath: '/tmp/project-a',
          messages: [],
        };
      }
      return {
        id,
        context: {},
        projectPath: '/tmp/project-a',
        messages: [],
      };
    });

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
      task: { prompt: 'same task but different session should dispatch async' },
      assignment: { taskId: 'task-active-bound-1', taskName: 'active-bound-task', blocked_by: ['none'] },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect((deps as any).agentRuntimeBlock.execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 0,
    }));
  });

  it('rejects project dispatch on system-owned session even without explicit projectPath', async () => {
    const { deps } = createDeps();
    const sessionManager = (deps as any).sessionManager;
    sessionManager.getSession.mockImplementation((id: string) => ({
      id,
      context: {
        sessionTier: 'system',
        ownerAgentId: 'finger-system-agent',
      },
      projectPath: '/Users/fanzhang/.finger/system',
      messages: [],
    }));

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'system-abc123',
      task: 'system session must not be used by project agent',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('project agent cannot run on system-owned session');
    expect((deps as any).agentRuntimeBlock.execute).not.toHaveBeenCalled();
  });
});
