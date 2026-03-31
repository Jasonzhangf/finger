import { describe, expect, it, vi } from 'vitest';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';

describe('task-report-dispatcher', () => {
  const createDeps = (overrides?: {
    dispatchReturn?: unknown;
    runtimeViewReturn?: unknown;
    runtimeCurrentSessionId?: string;
    sessions?: Array<{ id: string; context?: Record<string, unknown> }>;
    currentSessionId?: string;
  }) => {
    const execute = vi.fn().mockImplementation(async (command: string) => {
      if (command === 'runtime_view') {
        return overrides?.runtimeViewReturn ?? {
          agents: [{ id: 'finger-system-agent', status: 'idle' }],
        };
      }
      if (command === 'dispatch') {
        return overrides?.dispatchReturn ?? {
          ok: true,
          dispatchId: 'dispatch-123',
          status: 'queued',
        };
      }
      return {};
    });
    const sessions = new Map<string, { id: string; context?: Record<string, unknown> }>();
    for (const session of overrides?.sessions ?? []) {
      sessions.set(session.id, session);
    }
    const deps = {
      agentRuntimeBlock: { execute },
      runtime: {
        getCurrentSession: vi.fn(() => (
          overrides?.runtimeCurrentSessionId
            ? { id: overrides.runtimeCurrentSessionId }
            : null
        )),
      },
      sessionManager: {
        getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
        getCurrentSession: vi.fn(() => (
          overrides?.currentSessionId
            ? sessions.get(overrides.currentSessionId)
            : null
        )),
        getOrCreateSystemSession: vi.fn(() => ({ id: 'system-fallback' })),
      },
    } as any;
    return { deps, execute };
  };

  it('dispatches report to system agent with finger-project-agent source', async () => {
    const { deps, execute } = createDeps({
      sessions: [{ id: 'session-1' }],
    });

    const result = await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-1',
      taskSummary: 'summary',
      sessionId: 'session-1',
      result: 'success',
      projectId: 'project-1',
    });

    expect(result.ok).toBe(true);
    expect(result.dispatchId).toBe('dispatch-123');
    expect(result.status).toBe('queued');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-project-agent',
      targetAgentId: 'finger-system-agent',
      sessionId: 'session-1',
      blocking: false,
      metadata: expect.objectContaining({
        deliveryMode: 'direct',
        taskReportSchema: 'finger.task-report.v1',
        taskReport: expect.objectContaining({
          taskId: 'task-1',
          sessionId: 'session-1',
          projectId: 'project-1',
          status: 'completed',
        }),
      }),
    }));
  });

  it('normalizes failed dispatch result', async () => {
    const { deps } = createDeps({
      dispatchReturn: {
        ok: false,
        dispatchId: 'dispatch-failed',
        status: 'failed',
        error: 'target busy',
      },
      sessions: [{ id: 'session-2' }],
    });

    const result = await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-2',
      taskSummary: 'summary',
      sessionId: 'session-2',
      result: 'failure',
      projectId: 'project-2',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('target busy');
  });

  it('keeps mailbox delivery mode when system agent is busy', async () => {
    const { deps, execute } = createDeps({
      runtimeViewReturn: {
        agents: [{ id: 'finger-system-agent', status: 'running' }],
      },
      sessions: [{ id: 'session-busy' }],
    });

    await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-busy',
      taskSummary: 'summary',
      sessionId: 'session-busy',
      result: 'success',
      projectId: 'project-busy',
    });

    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      metadata: expect.not.objectContaining({
        deliveryMode: 'direct',
      }),
    }));
  });

  it('falls back to runtime current root session when requested session is invalid', async () => {
    const { deps, execute } = createDeps({
      runtimeCurrentSessionId: 'runtime-child-1',
      sessions: [
        { id: 'root-system-1' },
        {
          id: 'runtime-child-1',
          context: { sessionTier: 'runtime', parentSessionId: 'root-system-1', ownerAgentId: 'finger-project-agent' },
        },
      ],
    });

    await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-3',
      taskSummary: 'summary',
      sessionId: 'msg-1774330605368-q3vkv5',
      result: 'success',
      projectId: 'project-3',
    });

    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sessionId: 'root-system-1',
      metadata: expect.objectContaining({
        deliveryMode: 'direct',
        originalSessionId: 'msg-1774330605368-q3vkv5',
      }),
    }));
  });

  it('uses provided structured taskReport in dispatch metadata', async () => {
    const { deps, execute } = createDeps({
      sessions: [{ id: 'session-structured-1' }],
    });

    await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-structured-1',
      taskName: 'structured-report-path',
      taskSummary: 'Submitted for review',
      sessionId: 'session-structured-1',
      result: 'success',
      projectId: 'project-structured-1',
      sourceAgentId: 'finger-reviewer',
      taskReport: {
        schema: 'finger.task-report.v1',
        taskId: 'task-structured-1',
        taskName: 'structured-report-path',
        sessionId: 'session-structured-1',
        projectId: 'project-structured-1',
        sourceAgentId: 'finger-reviewer',
        result: 'success',
        status: 'review_ready',
        summary: 'Submitted for review',
        nextAction: 'review',
        deliveryClaim: true,
        createdAt: new Date().toISOString(),
      },
    });

    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-reviewer',
      metadata: expect.objectContaining({
        taskReport: expect.objectContaining({
          taskId: 'task-structured-1',
          status: 'review_ready',
          nextAction: 'review',
          deliveryClaim: true,
        }),
      }),
    }));
  });
});
