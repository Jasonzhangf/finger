import { beforeEach, describe, expect, it } from 'vitest';
import {
  updatePlanTool,
  resetUpdatePlanToolState,
  type PlanItemV2,
} from '../../src/tools/internal/codex-update-plan-tool.js';

const systemCtx = {
  invocationId: 'int-system',
  cwd: '/repo/app',
  timestamp: new Date().toISOString(),
  agentId: 'finger-system-agent',
  sessionId: 'system-main',
};

describe('update_plan v2 integration workflow', () => {
  beforeEach(() => {
    resetUpdatePlanToolState();
  });

  it('supports same-project multi-worker parallel non-blocking tasks', async () => {
    const taskA = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/app',
      item: {
        title: 'feature-A',
        assigneeWorkerId: 'Lisa',
        blockedBy: ['none'],
      },
    }, systemCtx);
    const taskB = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/app',
      item: {
        title: 'feature-B',
        assigneeWorkerId: 'Kelvin',
        blockedBy: ['none'],
      },
    }, systemCtx);

    const aInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: taskA.item?.id,
      expectedRevision: taskA.item?.revision,
      status: 'in_progress',
    }, systemCtx);
    const bInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: taskB.item?.id,
      expectedRevision: taskB.item?.revision,
      status: 'in_progress',
    }, systemCtx);

    expect(aInProgress.ok).toBe(true);
    expect(bInProgress.ok).toBe(true);

    const listed = await updatePlanTool.execute({
      action: 'list',
      projectPath: '/repo/app',
    }, systemCtx);
    const rows = (listed.items ?? []) as PlanItemV2[];
    const activeWorkers = rows
      .filter((row) => row.status === 'in_progress')
      .map((row) => row.assigneeWorkerId);
    expect(activeWorkers).toContain('Lisa');
    expect(activeWorkers).toContain('Kelvin');
  });

  it('review_pending does not block creating and progressing another task for same worker', async () => {
    const taskA = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/app',
      item: {
        title: 'deliver-A',
        assigneeWorkerId: 'Lisa',
      },
    }, systemCtx);
    const aProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: taskA.item?.id,
      expectedRevision: taskA.item?.revision,
      status: 'in_progress',
    }, systemCtx);
    const aReview = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: taskA.item?.id,
      expectedRevision: (aProgress.item as PlanItemV2).revision,
      status: 'review_pending',
    }, systemCtx);
    expect(aReview.ok).toBe(true);

    const taskB = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/app',
      item: {
        title: 'deliver-B',
        assigneeWorkerId: 'Lisa',
      },
    }, systemCtx);
    const bProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: taskB.item?.id,
      expectedRevision: taskB.item?.revision,
      status: 'in_progress',
    }, systemCtx);
    expect(bProgress.ok).toBe(true);
  });

  it('supports review reject loop: review_pending -> in_progress', async () => {
    const task = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/app',
      item: {
        title: 'reject-loop-task',
        assigneeWorkerId: 'Lisa',
      },
    }, systemCtx);
    const toProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: task.item?.id,
      expectedRevision: task.item?.revision,
      status: 'in_progress',
    }, systemCtx);
    const toReview = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: task.item?.id,
      expectedRevision: (toProgress.item as PlanItemV2).revision,
      status: 'review_pending',
    }, systemCtx);
    const backToProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/app',
      id: task.item?.id,
      expectedRevision: (toReview.item as PlanItemV2).revision,
      status: 'in_progress',
    }, systemCtx);

    expect(backToProgress.ok).toBe(true);
    expect(backToProgress.item?.status).toBe('in_progress');
  });
});

