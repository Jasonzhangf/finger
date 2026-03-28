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
      listRootSessions: vi.fn().mockReturnValue([]),
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
});
