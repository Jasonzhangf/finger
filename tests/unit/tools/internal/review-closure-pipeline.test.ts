import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerReportTaskCompletionTool } from '../../../../src/tools/internal/report-task-completion-tool.js';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';
import {
  getReviewRoute,
  removeReviewRoute,
} from '../../../../src/agents/finger-system-agent/review-route-registry.js';
import { emitTaskCompleted } from '../../../../src/agents/finger-system-agent/system-events.js';

vi.mock('../../../../src/agents/finger-system-agent/task-report-dispatcher.js', () => ({
  dispatchTaskToSystemAgent: vi.fn(),
}));

vi.mock('../../../../src/agents/finger-system-agent/system-events.js', () => ({
  emitTaskCompleted: vi.fn(),
}));

vi.mock('../../../../src/agents/finger-system-agent/review-route-registry.js', () => ({
  getReviewRoute: vi.fn(),
  getReviewRouteByTaskName: vi.fn(),
  removeReviewRoute: vi.fn(),
}));

describe('review closure pipeline (project -> reviewer -> system)', () => {
  function createSessionManagerStub() {
    return {
      getSession: vi.fn().mockReturnValue(null),
      updateContext: vi.fn(),
      addMessage: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-100',
      taskName: 'context-builder-rebuild-guard',
      reviewRequired: true,
      reviewAgentId: 'finger-reviewer',
      acceptanceCriteria: 'No implicit rebuild during continuation turns.',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
  });

  it('keeps same task identity across project delivery and reviewer pass', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const runtimeExecute = vi.fn().mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-review-1',
      status: 'queued',
    });
    vi.mocked(dispatchTaskToSystemAgent).mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-system-1',
      status: 'completed',
    });

    registerReportTaskCompletionTool(registry, () => ({
      agentRuntimeBlock: { execute: runtimeExecute },
      sessionManager: createSessionManagerStub(),
    }) as any);

    // Step 1: project agent reports completion -> dispatch to reviewer
    const projectResult = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-100',
      taskName: 'context-builder-rebuild-guard',
      taskSummary: 'Implemented rebuild guard + tests.',
      sessionId: 'session-project-1',
      result: 'success',
      projectId: 'finger',
      delivery_artifacts: 'changed files + vitest output',
    }, { agentId: 'finger-project-agent' });

    expect((projectResult as any).ok).toBe(true);
    expect(runtimeExecute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-project-agent',
      targetAgentId: 'finger-reviewer',
      queueOnBusy: true,
      maxQueueWaitMs: 0,
      metadata: expect.objectContaining({
        taskId: 'task-100',
        taskName: 'context-builder-rebuild-guard',
        reviewRequired: true,
      }),
    }));

    // Step 2: reviewer passes -> escalate to system and clear route
    const reviewerResult = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-100',
      taskSummary: 'PASS: acceptance criteria satisfied with evidence.',
      sessionId: 'session-project-1',
      result: 'success',
      projectId: 'finger',
    }, { agentId: 'finger-reviewer' });

    expect((reviewerResult as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: 'task-100',
      sourceAgentId: 'finger-reviewer',
      sessionId: 'session-project-1',
      taskReport: expect.objectContaining({
        schema: 'finger.task-report.v1',
        taskId: 'task-100',
        sourceAgentId: 'finger-reviewer',
      }),
    }));
    expect(removeReviewRoute).toHaveBeenCalledWith('task-100');
    expect(emitTaskCompleted).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: 'task-100',
      projectId: 'finger',
    }));
  });

  it('handles parallel-style multi-task closure (project -> reviewer -> system) without route collision', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const runtimeExecute = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-review-a',
        status: 'queued',
      })
      .mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-review-b',
        status: 'queued',
      });
    vi.mocked(dispatchTaskToSystemAgent)
      .mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-system-a',
        status: 'completed',
      })
      .mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-system-b',
        status: 'completed',
      });
    vi.mocked(getReviewRoute).mockImplementation((taskId: string) => {
      if (taskId === 'task-a') {
        return {
          taskId: 'task-a',
          taskName: 'worker-a-task',
          reviewRequired: true,
          reviewAgentId: 'finger-reviewer',
          acceptanceCriteria: 'A criteria',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as any;
      }
      if (taskId === 'task-b') {
        return {
          taskId: 'task-b',
          taskName: 'worker-b-task',
          reviewRequired: true,
          reviewAgentId: 'finger-reviewer',
          acceptanceCriteria: 'B criteria',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        } as any;
      }
      return undefined as any;
    });

    registerReportTaskCompletionTool(registry, () => ({
      agentRuntimeBlock: { execute: runtimeExecute },
      sessionManager: createSessionManagerStub(),
    }) as any);

    const projectA = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-a',
      taskName: 'worker-a-task',
      taskSummary: 'Worker A done with evidence.',
      sessionId: 'session-project-a',
      result: 'success',
      projectId: 'finger',
      delivery_artifacts: 'files-a + tests-a',
    }, { agentId: 'finger-project-agent' });
    const projectB = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-b',
      taskName: 'worker-b-task',
      taskSummary: 'Worker B done with evidence.',
      sessionId: 'session-project-b',
      result: 'success',
      projectId: 'finger',
      delivery_artifacts: 'files-b + tests-b',
    }, { agentId: 'finger-project-agent' });

    expect((projectA as any).ok).toBe(true);
    expect((projectB as any).ok).toBe(true);
    expect(runtimeExecute).toHaveBeenNthCalledWith(1, 'dispatch', expect.objectContaining({
      sourceAgentId: 'finger-project-agent',
      targetAgentId: 'finger-reviewer',
      metadata: expect.objectContaining({ taskId: 'task-a', taskName: 'worker-a-task' }),
    }));
    expect(runtimeExecute).toHaveBeenNthCalledWith(2, 'dispatch', expect.objectContaining({
      sourceAgentId: 'finger-project-agent',
      targetAgentId: 'finger-reviewer',
      metadata: expect.objectContaining({ taskId: 'task-b', taskName: 'worker-b-task' }),
    }));

    const reviewerA = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-a',
      taskSummary: 'PASS A',
      sessionId: 'session-project-a',
      result: 'success',
      projectId: 'finger',
    }, { agentId: 'finger-reviewer' });
    const reviewerB = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-b',
      taskSummary: 'PASS B',
      sessionId: 'session-project-b',
      result: 'success',
      projectId: 'finger',
    }, { agentId: 'finger-reviewer' });

    expect((reviewerA as any).ok).toBe(true);
    expect((reviewerB as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalledTimes(2);
    expect(dispatchTaskToSystemAgent).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({
      taskId: 'task-a',
      sourceAgentId: 'finger-reviewer',
      sessionId: 'session-project-a',
    }));
    expect(dispatchTaskToSystemAgent).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      taskId: 'task-b',
      sourceAgentId: 'finger-reviewer',
      sessionId: 'session-project-b',
    }));
    expect(removeReviewRoute).toHaveBeenCalledWith('task-a');
    expect(removeReviewRoute).toHaveBeenCalledWith('task-b');
  });
});
