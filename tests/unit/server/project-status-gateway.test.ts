import { describe, expect, it } from 'vitest';
import {
  applyProjectStatusGatewayPatch,
  listStaleProjectStatusSnapshots,
  readProjectStatusSnapshot,
} from '../../../src/server/modules/project-status-gateway.js';

function createSessionManagerMock(seed?: Record<string, Record<string, unknown>>) {
  const store = new Map<string, { id: string; projectPath: string; context: Record<string, unknown> }>();
  const initial = seed ?? {};
  for (const [sessionId, context] of Object.entries(initial)) {
    store.set(sessionId, {
      id: sessionId,
      projectPath: '/tmp/project-a',
      context: { ...context },
    });
  }
  return {
    getSession: (sessionId: string) => store.get(sessionId),
    listSessions: () => Array.from(store.values()),
    getContext: (sessionId: string) => {
      const session = store.get(sessionId);
      return session ? { ...session.context } : undefined;
    },
    updateContext: (sessionId: string, patch: Record<string, unknown>) => {
      const session = store.get(sessionId);
      if (!session) return false;
      session.context = { ...session.context, ...patch };
      return true;
    },
  };
}

describe('project-status-gateway', () => {
  it('applies valid transition create -> dispatched', () => {
    const sessionManager = createSessionManagerMock({
      'session-1': {
        projectTaskState: {
          active: true,
          status: 'create',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-1',
          blockedBy: ['none'],
          revision: 1,
        },
      },
    }) as any;

    const result = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-1'],
      source: 'test',
      patch: {
        status: 'dispatched',
        dispatchId: 'dispatch-1',
        revision: 2,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const snapshot = readProjectStatusSnapshot({
      sessionManager,
      sessionId: 'session-1',
      staleMs: 60_000,
    });
    expect(snapshot?.taskState?.status).toBe('dispatched');
    expect(snapshot?.taskState?.dispatchId).toBe('dispatch-1');
    expect(snapshot?.taskState?.revision).toBe(2);
  });

  it('rejects invalid transition from closed -> in_progress', () => {
    const sessionManager = createSessionManagerMock({
      'session-2': {
        projectTaskState: {
          active: false,
          status: 'closed',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-2',
          blockedBy: ['none'],
          revision: 3,
        },
      },
    }) as any;

    const result = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-2'],
      source: 'test',
      patch: {
        status: 'in_progress',
        revision: 4,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.error).toContain('invalid status transition');
    const snapshot = readProjectStatusSnapshot({
      sessionManager,
      sessionId: 'session-2',
      staleMs: 60_000,
    });
    expect(snapshot?.taskState?.status).toBe('closed');
  });

  it('rejects blocked_by that mixes none with dependency ids', () => {
    const sessionManager = createSessionManagerMock({
      'session-3': {
        projectTaskState: {
          active: true,
          status: 'create',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-3',
          blockedBy: ['none'],
          revision: 1,
        },
      },
    }) as any;

    const result = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-3'],
      source: 'test',
      patch: {
        status: 'dispatched',
        blockedBy: ['none', 'task-0'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]?.error).toContain('invalid blocked_by');
  });

  it('rejects out-of-order same revision event when patch is non-noop', () => {
    const sessionManager = createSessionManagerMock({
      'session-4': {
        projectTaskState: {
          active: true,
          status: 'dispatched',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-4',
          blockedBy: ['none'],
          revision: 5,
        },
      },
    }) as any;

    const result = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-4'],
      source: 'test',
      patch: {
        status: 'accepted',
        revision: 5,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.error).toContain('out-of-order event');
  });

  it('deduplicates same request_id/status/revision within TTL window', () => {
    const sessionManager = createSessionManagerMock({
      'session-5': {
        projectTaskState: {
          active: true,
          status: 'create',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-5',
          blockedBy: ['none'],
          revision: 1,
        },
      },
    }) as any;
    const first = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-5'],
      source: 'test',
      patch: {
        status: 'dispatched',
        requestId: 'req-123',
        revision: 2,
      },
    });
    expect(first.ok).toBe(true);
    const second = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-5'],
      source: 'test',
      patch: {
        status: 'dispatched',
        requestId: 'req-123',
        revision: 2,
      },
    });
    expect(second.ok).toBe(true);
    expect(second.appliedSessionIds).toEqual([]);
    expect(second.skippedSessionIds).toEqual(['session-5']);
  });

  it('lists stale snapshots with active-only filter', () => {
    const sessionManager = createSessionManagerMock({
      'session-6-a': {
        projectTaskState: {
          active: true,
          status: 'in_progress',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2020-04-03T08:00:00.000Z',
          taskId: 'task-a',
          blockedBy: ['none'],
          revision: 2,
        },
      },
      'session-6-b': {
        projectTaskState: {
          active: false,
          status: 'closed',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2020-04-03T08:00:00.000Z',
          taskId: 'task-b',
          blockedBy: ['none'],
          revision: 2,
        },
      },
    }) as any;

    const staleOnlyActive = listStaleProjectStatusSnapshots({
      sessionManager,
      staleMs: 1,
      onlyActive: true,
    });
    expect(staleOnlyActive.map((item) => item.sessionId)).toEqual(['session-6-a']);
  });

  it('keeps same-project multi-worker sessions isolated by session/task identity', () => {
    const sessionManager = createSessionManagerMock({
      'session-7-james': {
        projectTaskState: {
          active: true,
          status: 'dispatched',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-james',
          assigneeWorkerId: 'finger-project-agent-02',
          assigneeWorkerName: 'James',
          blockedBy: ['none'],
          revision: 2,
        },
      },
      'session-7-robin': {
        projectTaskState: {
          active: true,
          status: 'dispatched',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-robin',
          assigneeWorkerId: 'finger-project-agent-03',
          assigneeWorkerName: 'Robin',
          blockedBy: ['none'],
          revision: 2,
        },
      },
    }) as any;

    const jamesApply = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-7-james'],
      source: 'test',
      patch: {
        status: 'in_progress',
        taskId: 'task-james',
        assigneeWorkerId: 'finger-project-agent-02',
        assigneeWorkerName: 'James',
      },
    });
    const robinApply = applyProjectStatusGatewayPatch({
      sessionManager,
      sessionIds: ['session-7-robin'],
      source: 'test',
      patch: {
        status: 'in_progress',
        taskId: 'task-robin',
        assigneeWorkerId: 'finger-project-agent-03',
        assigneeWorkerName: 'Robin',
      },
    });

    expect(jamesApply.ok).toBe(true);
    expect(robinApply.ok).toBe(true);
    const jamesSnapshot = readProjectStatusSnapshot({ sessionManager, sessionId: 'session-7-james' });
    const robinSnapshot = readProjectStatusSnapshot({ sessionManager, sessionId: 'session-7-robin' });
    expect(jamesSnapshot?.taskState?.taskId).toBe('task-james');
    expect(jamesSnapshot?.taskState?.assigneeWorkerName).toBe('James');
    expect(robinSnapshot?.taskState?.taskId).toBe('task-robin');
    expect(robinSnapshot?.taskState?.assigneeWorkerName).toBe('Robin');
  });

  it('restores stable snapshot after restart-like reload from persisted context', () => {
    const managerA = createSessionManagerMock({
      'session-8': {
        projectTaskState: {
          active: true,
          status: 'accepted',
          sourceAgentId: 'finger-system-agent',
          targetAgentId: 'finger-project-agent',
          updatedAt: '2026-04-03T08:00:00.000Z',
          taskId: 'task-restart',
          blockedBy: ['none'],
          revision: 2,
        },
      },
    }) as any;
    const apply = applyProjectStatusGatewayPatch({
      sessionManager: managerA,
      sessionIds: ['session-8'],
      source: 'test',
      patch: {
        status: 'in_progress',
        taskId: 'task-restart',
      },
    });
    expect(apply.ok).toBe(true);
    const persistedContext = managerA.getContext('session-8');
    const managerB = createSessionManagerMock({
      'session-8': persistedContext ?? {},
    }) as any;
    const restored = readProjectStatusSnapshot({
      sessionManager: managerB,
      sessionId: 'session-8',
    });
    expect(restored?.taskState?.status).toBe('in_progress');
    expect(restored?.taskState?.taskId).toBe('task-restart');
    expect(restored?.taskState?.revision).toBeGreaterThanOrEqual(3);
  });
});
