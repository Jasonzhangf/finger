import { describe, expect, it, vi } from 'vitest';
import {
  applyExecutionLifecycleTransition,
  getExecutionLifecycleState,
  resolveLifecycleStageFromResultStatus,
  transitionExecutionLifecycle,
} from '../../../src/server/modules/execution-lifecycle.js';

function createSessionManager() {
  const sessions = new Map<string, { id: string; context: Record<string, unknown> }>();
  sessions.set('session-1', { id: 'session-1', context: {} });
  return {
    sessions,
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId) ?? null),
    updateContext: vi.fn((sessionId: string, context: Record<string, unknown>) => {
      const session = sessions.get(sessionId);
      if (!session) return false;
      session.context = { ...session.context, ...context };
      return true;
    }),
  };
}

describe('execution-lifecycle', () => {
  it('starts a new lifecycle on received and preserves startedAt for later transitions', () => {
    const received = transitionExecutionLifecycle(null, {
      stage: 'received',
      messageId: 'msg-1',
      updatedBy: 'test',
    }, '2026-03-28T08:00:00.000Z');

    const bound = transitionExecutionLifecycle(received, {
      stage: 'session_bound',
      updatedBy: 'test',
    }, '2026-03-28T08:00:05.000Z');

    expect(received.startedAt).toBe('2026-03-28T08:00:00.000Z');
    expect(bound.startedAt).toBe('2026-03-28T08:00:00.000Z');
    expect(bound.lastTransitionAt).toBe('2026-03-28T08:00:05.000Z');
    expect(bound.messageId).toBe('msg-1');
  });

  it('increments retry count only when requested', () => {
    const received = transitionExecutionLifecycle(null, { stage: 'received' }, '2026-03-28T08:00:00.000Z');
    const retrying = transitionExecutionLifecycle(received, {
      stage: 'retrying',
      incrementRetry: true,
      lastError: 'timeout',
    }, '2026-03-28T08:00:02.000Z');

    const running = transitionExecutionLifecycle(retrying, {
      stage: 'running',
      lastError: null,
    }, '2026-03-28T08:00:03.000Z');

    expect(retrying.retryCount).toBe(1);
    expect(retrying.lastError).toBe('timeout');
    expect(running.retryCount).toBe(1);
    expect(running.lastError).toBeUndefined();
  });

  it('prevents terminal lifecycle regression by default', () => {
    const completed = transitionExecutionLifecycle(null, {
      stage: 'completed',
      updatedBy: 'test',
    }, '2026-03-28T08:00:00.000Z');

    const regressed = transitionExecutionLifecycle(completed, {
      stage: 'running',
      updatedBy: 'stale-event',
    }, '2026-03-28T08:00:01.000Z');

    expect(regressed).toBe(completed);
    expect(regressed.stage).toBe('completed');
  });

  it('allows explicit terminal-to-waiting_user transition when flagged', () => {
    const completed = transitionExecutionLifecycle(null, {
      stage: 'completed',
      updatedBy: 'test',
    }, '2026-03-28T08:00:00.000Z');

    const waiting = transitionExecutionLifecycle(completed, {
      stage: 'waiting_user',
      substage: 'waiting_for_user',
      updatedBy: 'event-forwarding',
      allowFromTerminal: true,
    }, '2026-03-28T08:00:02.000Z');

    expect(waiting.stage).toBe('waiting_user');
    expect(waiting.substage).toBe('waiting_for_user');
  });

  it('allows terminal-to-terminal normalization transitions', () => {
    const interrupted = transitionExecutionLifecycle(null, {
      stage: 'interrupted',
      substage: 'turn_stop_tool_pending',
      finishReason: 'stop',
      updatedBy: 'test',
    }, '2026-03-28T08:00:00.000Z');

    const normalized = transitionExecutionLifecycle(interrupted, {
      stage: 'completed',
      substage: 'startup_reset_after_stop',
      finishReason: 'stop',
      updatedBy: 'system-agent-manager',
    }, '2026-03-28T08:00:02.000Z');

    expect(normalized.stage).toBe('completed');
    expect(normalized.substage).toBe('startup_reset_after_stop');
  });

  it('persists lifecycle state into session context', () => {
    const sessionManager = createSessionManager();

    applyExecutionLifecycleTransition(sessionManager as any, 'session-1', {
      stage: 'received',
      messageId: 'msg-2',
      updatedBy: 'message-route',
      targetAgentId: 'finger-system-agent',
    });
    applyExecutionLifecycleTransition(sessionManager as any, 'session-1', {
      stage: 'dispatching',
      dispatchId: 'dispatch-2',
      updatedBy: 'dispatch',
    });

    const state = getExecutionLifecycleState(sessionManager as any, 'session-1');
    expect(state).not.toBeNull();
    expect(state?.stage).toBe('dispatching');
    expect(state?.messageId).toBe('msg-2');
    expect(state?.dispatchId).toBe('dispatch-2');
    expect(state?.targetAgentId).toBe('finger-system-agent');
  });

  it('tracks structured recovery metadata across transitions', () => {
    const received = transitionExecutionLifecycle(null, { stage: 'received' }, '2026-03-28T08:00:00.000Z');
    const retrying = transitionExecutionLifecycle(received, {
      stage: 'retrying',
      incrementRetry: true,
      timeoutMs: 60_000,
      retryDelayMs: 2_000,
      recoveryAction: 'retry',
      delivery: 'queue',
    }, '2026-03-28T08:00:02.000Z');

    expect(retrying.timeoutMs).toBe(60_000);
    expect(retrying.retryDelayMs).toBe(2_000);
    expect(retrying.recoveryAction).toBe('retry');
    expect(retrying.delivery).toBe('queue');
  });

  it('maps result status strings into lifecycle stages', () => {
    expect(resolveLifecycleStageFromResultStatus('queued')).toBe('dispatching');
    expect(resolveLifecycleStageFromResultStatus('processing')).toBe('dispatching');
    expect(resolveLifecycleStageFromResultStatus('completed')).toBe('completed');
    expect(resolveLifecycleStageFromResultStatus('failed')).toBe('failed');
    expect(resolveLifecycleStageFromResultStatus('weird-status')).toBeNull();
  });

  it('self-heals stale system alias session ids by remapping to current system session', () => {
    const sessionManager = createSessionManager() as ReturnType<typeof createSessionManager> & {
      getOrCreateSystemSession: () => { id: string };
    };
    sessionManager.sessions.set('session-system-current', {
      id: 'session-system-current',
      context: {},
    });
    sessionManager.getOrCreateSystemSession = vi.fn(() => ({
      id: 'session-system-current',
    }));

    const applied = applyExecutionLifecycleTransition(
      sessionManager as any,
      'system-legacy-stale',
      {
        stage: 'running',
        updatedBy: 'test',
      },
    );

    expect(applied).not.toBeNull();
    expect(sessionManager.getOrCreateSystemSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      'session-system-current',
      expect.objectContaining({
        executionLifecycle: expect.objectContaining({
          stage: 'running',
          updatedBy: 'test',
        }),
      }),
    );
  });
});
