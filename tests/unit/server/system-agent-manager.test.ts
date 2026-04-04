import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SystemAgentManager } from '../../../src/server/modules/system-agent-manager.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';
import { PeriodicCheckRunner } from '../../../src/agents/finger-system-agent/periodic-check.js';

describe('SystemAgentManager - Session Reuse', () => {
  let mockSessionManager: any;
  let mockAgentRuntimeBlock: any;
  let deps: AgentRuntimeDeps;

  beforeEach(() => {
    // Mock sessionManager
    mockSessionManager = {
      getOrCreateSystemSession: vi.fn(),
      ensureSession: vi.fn(),
      createSession: vi.fn(),
      listRootSessions: vi.fn().mockReturnValue([]),
      findSessionsByProjectPath: vi.fn().mockReturnValue([]),
      getSession: vi.fn(),
      updateContext: vi.fn().mockReturnValue(true),
    };

    // Mock agentRuntimeBlock
    mockAgentRuntimeBlock = {
      execute: vi.fn().mockResolvedValue({ ok: true, dispatchId: 'mock-dispatch-id' }),
    };

    deps = {
      sessionManager: mockSessionManager,
      agentRuntimeBlock: mockAgentRuntimeBlock,
      isRuntimeChildSession: vi.fn().mockReturnValue(false),
    } as unknown as AgentRuntimeDeps;
  });

  it('should reuse existing system session when it exists', async () => {
    const existingSession = {
      id: 'existing-system-session-123',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T00:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(existingSession);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Verify getOrCreateSystemSession was called
    expect(mockSessionManager.getOrCreateSystemSession).toHaveBeenCalled();

    // Startup bootstrap auto-check is disabled: no dispatch should be sent automatically
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeUndefined();

    // But deploy should still use the resolved system session
    const deployCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'deploy'
    );
    expect(deployCall).toBeDefined();
    expect(deployCall[1].sessionId).toBe(existingSession.id);
  });

  it('should create new session when no system session exists', async () => {
    const newSession = {
      id: 'new-system-session-456',
      name: 'System Agent Bootstrap',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T08:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(newSession);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Verify getOrCreateSystemSession was called
    expect(mockSessionManager.getOrCreateSystemSession).toHaveBeenCalled();

    // Startup bootstrap auto-check is disabled: no dispatch should be sent automatically
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeUndefined();

    const deployCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'deploy'
    );
    expect(deployCall).toBeDefined();
    expect(deployCall[1].sessionId).toBe(newSession.id);
  });

  it('should not create multiple sessions on restart', async () => {
    const existingSession = {
      id: 'reused-system-session-789',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-17T00:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(existingSession);

    const manager1 = new SystemAgentManager(deps);
    await manager1.start();
    const firstCallCount = mockSessionManager.getOrCreateSystemSession.mock.calls.length;

    // Simulate restart: create new manager instance
    const manager2 = new SystemAgentManager(deps);
    await manager2.start();
    const secondCallCount = mockSessionManager.getOrCreateSystemSession.mock.calls.length;

    // getOrCreateSystemSession should be called exactly twice (once per manager)
    expect(secondCallCount).toBe(firstCallCount + 1);

    // Both starts should avoid bootstrap auto-dispatch
    const dispatchCalls = mockAgentRuntimeBlock.execute.mock.calls.filter(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCalls.length).toBe(0);
  });

  it('should handle session creation error gracefully', async () => {
    mockSessionManager.getOrCreateSystemSession.mockImplementation(() => {
      throw new Error('Failed to create session');
    });

    const manager = new SystemAgentManager(deps);
    await manager.start();

    // Startup bootstrap auto-check is disabled, so no dispatch even on fallback
    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
    );
    expect(dispatchCall).toBeUndefined();

    const deployCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'deploy'
    );
    expect(deployCall).toBeDefined();
    expect(deployCall[1].sessionId).toBe('default');
  });

  it('should respect periodic check switch (default off, optional on)', async () => {
    const startSpy = vi.spyOn(PeriodicCheckRunner.prototype, 'start');
    const stopSpy = vi.spyOn(PeriodicCheckRunner.prototype, 'stop');
    const session = {
      id: 'system-session-opts',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-24T00:00:00Z',
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);

    const enabledManager = new SystemAgentManager(deps, {
      periodicCheck: { enabled: true, intervalMs: 12345 },
    });
    await enabledManager.start();
    expect(startSpy).toHaveBeenCalled();
    enabledManager.stop();
    expect(stopSpy).toHaveBeenCalled();

    startSpy.mockClear();
    stopSpy.mockClear();

    const disabledManager = new SystemAgentManager(deps, {
      periodicCheck: { enabled: false },
    });
    await disabledManager.start();
    expect(startSpy).not.toHaveBeenCalled();
    disabledManager.stop();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('should dispatch interrupted execution recovery on startup when previous turn did not stop', async () => {
    const session = {
      id: 'system-session-recover',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-28T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'running',
          startedAt: '2026-03-28T00:00:00Z',
          lastTransitionAt: '2026-03-28T00:01:00Z',
          retryCount: 0,
          substage: 'turn_start',
        },
      },
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);
    mockSessionManager.getSession.mockReturnValue(session);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch',
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall?.[1]?.metadata?.source).toBe('system-recovery');
    expect(dispatchCall?.[1]?.metadata?.progressDelivery).toEqual({ mode: 'silent' });
  });

  it('should not resume startup execution when lifecycle is already completed without finish_reason=stop', async () => {
    const session = {
      id: 'system-session-completed-without-stop',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-28T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'completed',
          startedAt: '2026-03-28T00:00:00Z',
          lastTransitionAt: '2026-03-28T00:01:00Z',
          retryCount: 0,
          substage: 'turn_complete',
        },
      },
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);
    mockSessionManager.getSession.mockReturnValue(session);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    const recoveryDispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch' && (call[1] as Record<string, unknown>)?.metadata
        && ((call[1] as { metadata?: { source?: string } }).metadata?.source === 'system-recovery'),
    );
    expect(recoveryDispatchCall).toBeUndefined();
  });

  it('should dispatch silent startup delivery review on startup when previous turn stopped', async () => {
    const session = {
      id: 'system-session-review',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-28T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'completed',
          startedAt: '2026-03-28T00:00:00Z',
          lastTransitionAt: '2026-03-28T00:02:00Z',
          retryCount: 0,
          substage: 'turn_complete',
          finishReason: 'stop',
          turnId: 'turn-1',
        },
      },
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);
    mockSessionManager.getSession.mockReturnValue(session);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch',
    );
    expect(dispatchCall).toBeDefined();
    expect(dispatchCall?.[1]?.metadata?.source).toBe('system-startup-review');
    expect(dispatchCall?.[1]?.metadata?.progressDelivery).toEqual({ mode: 'silent' });
    expect(mockSessionManager.updateContext).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        startupCompletionReviewCheckpoint: expect.any(String),
      }),
    );
  });

  it('should resume startup execution when stop-tool gate is pending even with finish_reason=stop', async () => {
    const session = {
      id: 'system-session-stop-tool-pending',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-28T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'interrupted',
          startedAt: '2026-03-28T00:00:00Z',
          lastTransitionAt: '2026-03-28T00:02:00Z',
          retryCount: 0,
          substage: 'turn_stop_tool_pending',
          finishReason: 'stop',
          turnId: 'turn-stop-tool-pending-1',
        },
      },
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);
    mockSessionManager.getSession.mockReturnValue(session);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    const recoveryDispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch' && (call[1] as Record<string, unknown>)?.metadata
        && ((call[1] as { metadata?: { source?: string } }).metadata?.source === 'system-recovery'),
    );
    expect(recoveryDispatchCall).toBeDefined();
    expect((recoveryDispatchCall?.[1] as { metadata?: { progressDelivery?: unknown } })?.metadata?.progressDelivery)
      .toEqual({ mode: 'silent' });
  });

  it('should not dispatch duplicate startup review after restart when same stopped task only changed turn metadata', async () => {
    const checkpoint = 'startup-review::stop::msg-user-1';
    const session = {
      id: 'system-session-review-dedupe',
      name: 'finger-system-agent runtime',
      projectPath: '/tmp/system',
      createdAt: '2026-03-28T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'completed',
          startedAt: '2026-03-28T00:00:00Z',
          lastTransitionAt: '2026-03-28T00:05:00Z',
          retryCount: 0,
          substage: 'turn_complete',
          finishReason: 'stop',
          messageId: 'msg-user-1',
          turnId: 'internal-review-turn-2',
          dispatchId: 'dispatch-internal-review-2',
        },
        startupCompletionReviewCheckpoint: checkpoint,
      },
    };
    mockSessionManager.getOrCreateSystemSession.mockReturnValue(session);
    mockSessionManager.getSession.mockReturnValue(session);

    const manager = new SystemAgentManager(deps);
    await manager.start();

    const dispatchCalls = mockAgentRuntimeBlock.execute.mock.calls.filter(
      (call: unknown[]) => call[0] === 'dispatch',
    );
    expect(dispatchCalls).toHaveLength(0);
  });

  it('should skip project startup recovery dispatch when target session already has active kernel turn', async () => {
    const projectSessionId = 'project-session-inflight';
    const projectSession = {
      id: projectSessionId,
      name: 'project-runtime',
      projectPath: '/tmp/project-inflight',
      createdAt: '2026-03-31T00:00:00Z',
      context: {
        executionLifecycle: {
          stage: 'running',
          startedAt: '2026-03-31T00:00:00Z',
          lastTransitionAt: '2026-03-31T00:01:00Z',
          retryCount: 0,
          substage: 'turn_start',
        },
      },
    };

    mockAgentRuntimeBlock.execute.mockImplementation(async (action: string, payload: Record<string, unknown>) => {
      if (action === 'control' && payload.action === 'status') {
        return {
          ok: true,
          action: 'status',
          status: 'completed',
          result: {
            chatCodexSessions: [
              {
                sessionId: projectSessionId,
                providerId: 'tcm',
                hasActiveTurn: true,
                activeTurnId: 'turn-123',
              },
            ],
          },
        };
      }
      return { ok: true, status: 'queued', dispatchId: 'mock-dispatch-id' };
    });
    mockSessionManager.getSession.mockImplementation((sessionId: string) => {
      if (sessionId === projectSessionId) return projectSession;
      return null;
    });

    const manager = new SystemAgentManager(deps);
    await (manager as any).resumeProjectSessionIfNeeded({
      projectPath: '/tmp/project-inflight',
      projectId: '/tmp/project-inflight',
      agentId: 'project-inflight-01',
    }, projectSessionId);

    const projectRecoveryDispatchCalls = mockAgentRuntimeBlock.execute.mock.calls.filter(
      (call: unknown[]) => call[0] === 'dispatch'
        && (call[1] as { sourceAgentId?: string }).sourceAgentId === 'system-project-recovery',
    );
    expect(projectRecoveryDispatchCalls).toHaveLength(0);
  });

  it('should recover actionable project task state from same-project sibling session when primary session lacks state', async () => {
    const primarySessionId = 'project-session-primary';
    const siblingSessionId = 'project-session-sibling-active';
    const nowIso = new Date().toISOString();
    const primarySession = {
      id: primarySessionId,
      projectPath: '/tmp/project-recover',
      context: {},
    };
    const siblingSession = {
      id: siblingSessionId,
      projectPath: '/tmp/project-recover',
      context: {
        projectTaskState: {
          active: true,
          status: 'in_progress',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: nowIso,
          taskId: 'task-recover-1',
          taskName: 'recover-task',
        },
      },
    };
    mockSessionManager.findSessionsByProjectPath.mockReturnValue([primarySession, siblingSession]);
    mockSessionManager.getSession.mockImplementation((sessionId: string) => {
      if (sessionId === primarySessionId) return primarySession;
      if (sessionId === siblingSessionId) return siblingSession;
      return null;
    });
    mockSessionManager.getOrCreateSystemSession.mockReturnValue({ id: 'system-session-root' });

    const manager = new SystemAgentManager(deps);
    const recovered = (manager as any).resolveActionableProjectTaskStateForRecovery(primarySessionId);
    expect(recovered).toBeTruthy();
    expect(recovered.sessionId).toBe(siblingSessionId);
    expect(recovered.state.taskId).toBe('task-recover-1');
  });

  it('should never reuse system session as monitored project session', async () => {
    const manager = new SystemAgentManager(deps);
    const systemSession = {
      id: 'system-1774838274317-jkpzq4',
      projectPath: '/Users/fanzhang/.finger/system',
      context: {
        sessionTier: 'system',
        ownerAgentId: 'finger-system-agent',
      },
    };
    mockSessionManager.getSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'system-1774838274317-jkpzq4') return systemSession;
      return null;
    });
    mockSessionManager.findSessionsByProjectPath.mockReturnValue([]);
    mockSessionManager.createSession.mockReturnValue({ id: 'project-session-new-001' });

    const resolved = (manager as any).resolveProjectSessionIdForRecovery({
      projectPath: '/Users/fanzhang/github/webauto',
      projectId: '/users/fanzhang/github/webauto',
      projectName: 'webauto',
      agentId: 'webauto-01',
      lastSessionId: 'system-1774838274317-jkpzq4',
    });

    expect(resolved).toBe('project-session-new-001');
  });

  it('should skip starting monitored project when project path is system workspace', async () => {
    const manager = new SystemAgentManager(deps);
    await (manager as any).startProjectAgent({
      projectPath: '/Users/fanzhang/.finger/system',
      projectId: '/users/fanzhang/.finger/system',
      projectName: 'system',
      agentId: 'system-01',
      status: 'idle',
      lastHeartbeat: new Date().toISOString(),
      stats: { tasksCompleted: 0, tasksFailed: 0, uptime: 0 },
      monitored: true,
    });

    const deployCalls = mockAgentRuntimeBlock.execute.mock.calls.filter(
      (call: unknown[]) => call[0] === 'deploy',
    );
    expect(deployCalls).toHaveLength(0);
  });

  it('uses existing assigneeWorkerId when recovering monitored project task', async () => {
    const projectSessionId = 'project-session-worker-assigned';
    const projectSession = {
      id: projectSessionId,
      projectPath: '/tmp/project-worker-assigned',
      context: {
        projectTaskState: {
          active: true,
          status: 'in_progress',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          taskId: 'task-worker-assigned',
          taskName: 'recover-with-worker',
          assigneeWorkerId: 'Lisa',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    mockSessionManager.findSessionsByProjectPath.mockReturnValue([projectSession]);
    mockSessionManager.getSession.mockImplementation((sessionId: string) => (
      sessionId === projectSessionId ? projectSession : null
    ));
    mockAgentRuntimeBlock.execute.mockImplementation(async (action: string) => {
      if (action === 'control') {
        return {
          ok: true,
          result: {
            chatCodexSessions: [{ sessionId: projectSessionId, hasActiveTurn: false }],
          },
        };
      }
      return { ok: true, status: 'queued', dispatchId: 'dispatch-worker-assigned' };
    });

    const manager = new SystemAgentManager(deps);
    await (manager as any).resumeProjectSessionIfNeeded({
      projectPath: '/tmp/project-worker-assigned',
      projectId: '/tmp/project-worker-assigned',
      agentId: 'project-worker-assigned-01',
    }, projectSessionId);

    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
        && (call[1] as { sourceAgentId?: string }).sourceAgentId === 'system-project-recovery',
    );
    expect(dispatchCall).toBeDefined();
    expect((dispatchCall?.[1] as any).metadata.assigneeWorkerId).toBe('Lisa');
    expect(mockSessionManager.updateContext).not.toHaveBeenCalled();
  });

  it('reassigns missing assigneeWorkerId on recovery and records reassign reason', async () => {
    const projectSessionId = 'project-session-worker-missing';
    const projectSession = {
      id: projectSessionId,
      projectPath: '/tmp/project-worker-missing',
      context: {
        projectTaskState: {
          active: true,
          status: 'in_progress',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          taskId: 'task-worker-missing',
          taskName: 'recover-missing-worker',
          updatedAt: new Date().toISOString(),
        },
      },
    };
    mockSessionManager.findSessionsByProjectPath.mockReturnValue([projectSession]);
    mockSessionManager.getSession.mockImplementation((sessionId: string) => (
      sessionId === projectSessionId ? projectSession : null
    ));
    mockAgentRuntimeBlock.execute.mockImplementation(async (action: string) => {
      if (action === 'control') {
        return {
          ok: true,
          result: {
            chatCodexSessions: [{ sessionId: projectSessionId, hasActiveTurn: false }],
          },
        };
      }
      return { ok: true, status: 'queued', dispatchId: 'dispatch-worker-missing' };
    });

    const manager = new SystemAgentManager(deps);
    await (manager as any).resumeProjectSessionIfNeeded({
      projectPath: '/tmp/project-worker-missing',
      projectId: '/tmp/project-worker-missing',
      agentId: 'project-worker-missing-01',
    }, projectSessionId);

    const dispatchCall = mockAgentRuntimeBlock.execute.mock.calls.find(
      (call: unknown[]) => call[0] === 'dispatch'
        && (call[1] as { sourceAgentId?: string }).sourceAgentId === 'system-project-recovery',
    );
    expect(dispatchCall).toBeDefined();
    expect((dispatchCall?.[1] as any).metadata.assigneeWorkerId).toBe('finger-project-agent');
    expect(mockSessionManager.updateContext).toHaveBeenCalledWith(
      projectSessionId,
      expect.objectContaining({
        projectTaskState: expect.objectContaining({
          taskId: 'task-worker-missing',
          assigneeWorkerId: 'finger-project-agent',
          reassignReason: 'assignee_worker_missing_reassigned_to_default',
        }),
      }),
    );
  });
});
