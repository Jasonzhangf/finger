/**
 * Agent Runtime Control - Cascade Interrupt Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    module: () => ({
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

describe('Cascade interrupt via controlAgentRuntime', () => {
  beforeEach(async () => {
    const { resetGlobalDispatchTracker } = await import(
      '../../src/server/modules/agent-runtime/dispatch-tracker.js'
    );
    resetGlobalDispatchTracker();
  });

  it('should cascade interrupt when parent session is interrupted', async () => {
    const { controlAgentRuntime } = await import(
      '../../src/server/modules/agent-runtime/control.js'
    );
    const { getGlobalDispatchTracker } = await import(
      '../../src/server/modules/agent-runtime/dispatch-tracker.js'
    );

    const tracker = getGlobalDispatchTracker();
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'parent-session',
      childSessionId: 'child-session-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path1',
    });
    tracker.track({
      dispatchId: 'dispatch-2',
      parentSessionId: 'child-session-1',
      childSessionId: 'child-session-2',
      sourceAgentId: 'project:/path1',
      targetAgentId: 'project:/path2',
    });

    const interruptedSessions: string[] = [];
    const mockExecute = vi.fn().mockImplementation((command: string, input: Record<string, unknown>) => {
      if (command === 'control' && input.sessionId) {
        interruptedSessions.push(input.sessionId as string);
        return { ok: true, action: input.action, status: 'completed', sessionId: input.sessionId };
      }
      return { ok: true, action: input.action, status: 'completed' };
    });

    const mockSessionManager = {
      listSessions: vi.fn().mockReturnValue([]),
      getSession: vi.fn().mockReturnValue(null),
      updateContext: vi.fn(),
    };

    const deps = {
      agentRuntimeBlock: { execute: mockExecute },
      sessionManager: mockSessionManager,
    } as any;

    const result = await controlAgentRuntime(deps, {
      action: 'interrupt',
      sessionId: 'parent-session',
    });

    expect(result.ok).toBe(true);
    expect(interruptedSessions).toContain('parent-session');
    expect(interruptedSessions).toContain('child-session-1');
    expect(interruptedSessions).toContain('child-session-2');

    const cascadeResult = (result.result as any)?.cascade;
    expect(cascadeResult).toBeDefined();
    expect(cascadeResult.interruptedSessionIds).toContain('child-session-1');
    expect(cascadeResult.interruptedSessionIds).toContain('child-session-2');
  });

  it('should not cascade for status/pause/resume actions', async () => {
    const { controlAgentRuntime } = await import(
      '../../src/server/modules/agent-runtime/control.js'
    );

    const mockExecute = vi.fn().mockResolvedValue({
      ok: true,
      action: 'status',
      status: 'completed',
    });

    const deps = {
      agentRuntimeBlock: { execute: mockExecute },
      sessionManager: { listSessions: vi.fn().mockReturnValue([]) },
    } as any;

    await controlAgentRuntime(deps, { action: 'status' });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('should not cascade when interrupt fails', async () => {
    const { controlAgentRuntime } = await import(
      '../../src/server/modules/agent-runtime/control.js'
    );

    const mockExecute = vi.fn().mockResolvedValue({
      ok: false,
      action: 'interrupt',
      status: 'failed',
      error: 'session not found',
    });

    const deps = {
      agentRuntimeBlock: { execute: mockExecute },
      sessionManager: { listSessions: vi.fn().mockReturnValue([]) },
    } as any;

    const result = await controlAgentRuntime(deps, {
      action: 'interrupt',
      sessionId: 'nonexistent',
    });

    expect(result.ok).toBe(false);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
