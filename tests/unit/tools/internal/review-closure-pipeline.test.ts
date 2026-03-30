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
      sessionManager: {},
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
    }));
    expect(removeReviewRoute).toHaveBeenCalledWith('task-100');
    expect(emitTaskCompleted).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: 'task-100',
      projectId: 'finger',
    }));
  });
});

