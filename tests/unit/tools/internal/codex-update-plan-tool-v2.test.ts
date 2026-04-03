import { describe, it, expect, beforeEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  updatePlanTool,
  resetUpdatePlanToolState,
  reloadUpdatePlanToolStateFromDiskForTest,
  getUpdatePlanRuntimeView,
  type PlanItemV2,
} from '../../../../src/tools/internal/codex-update-plan-tool.js';

const systemCtx = {
  invocationId: 't-system',
  cwd: '/repo/a',
  timestamp: new Date().toISOString(),
  agentId: 'finger-system-agent',
  sessionId: 'system-1',
};

describe('update_plan v2 contract', () => {
  beforeEach(() => {
    process.env.FINGER_UPDATE_PLAN_STORE_FILE = join(tmpdir(), `finger-update-plan-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    resetUpdatePlanToolState();
  });

  it('supports create/list/search actions with BD-like item fields', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'Implement plan contract',
        type: 'task',
        status: 'open',
        assigneeWorkerId: 'finger-worker-01',
        blockedBy: ['none'],
        dependsOn: [],
        acceptanceCriteria: ['contract ready'],
      },
    }, systemCtx);

    expect(created.ok).toBe(true);
    expect(created.action).toBe('create');
    expect(created.item?.id).toMatch(/^plan-/);
    expect(created.item?.revision).toBe(1);
    expect(created.item?.projectPath).toBe('/repo/a');
    expect(created.item?.status).toBe('open');

    const listed = await updatePlanTool.execute({
      action: 'list',
      projectPath: '/repo/a',
    }, systemCtx);
    expect(listed.ok).toBe(true);
    expect(Array.isArray(listed.items)).toBe(true);
    expect(listed.items).toHaveLength(1);
    expect((listed.items as PlanItemV2[])[0].title).toContain('Implement plan contract');

    const searched = await updatePlanTool.execute({
      action: 'search',
      projectPath: '/repo/a',
      query: 'contract',
    }, systemCtx);
    expect(searched.ok).toBe(true);
    expect(searched.items).toHaveLength(1);
  });

  it('persists plan store to disk and can reload after in-memory reset', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'Persisted task',
        assigneeWorkerId: 'finger-worker-01',
      },
    }, systemCtx);
    expect(created.ok).toBe(true);

    reloadUpdatePlanToolStateFromDiskForTest();

    const listed = await updatePlanTool.execute({
      action: 'list',
      projectPath: '/repo/a',
    }, systemCtx);
    expect(listed.ok).toBe(true);
    expect(listed.items?.some((item) => item.title === 'Persisted task')).toBe(true);

    const searched = await updatePlanTool.execute({
      action: 'search',
      projectPath: '/repo/a',
      query: 'Persisted task',
    }, systemCtx);
    expect(searched.ok).toBe(true);
    expect(searched.items?.some((item) => item.title === 'Persisted task')).toBe(true);
  });

  it('returns revision_conflict when write action misses expectedRevision', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'Need CAS',
        assigneeWorkerId: 'finger-worker-01',
      },
    }, systemCtx);
    const id = created.item?.id as string;

    const updated = await updatePlanTool.execute({
      action: 'update',
      projectPath: '/repo/a',
      id,
      patch: { description: 'new description' },
    }, systemCtx);

    expect(updated.ok).toBe(false);
    expect(updated.errorCode).toBe('revision_conflict');
  });

  it('returns invalid_transition on illegal status change', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'Transition check',
        assigneeWorkerId: 'finger-worker-01',
      },
    }, systemCtx);
    const item = created.item as PlanItemV2;

    const setStatus = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: item.revision,
      status: 'done',
    }, systemCtx);

    expect(setStatus.ok).toBe(false);
    expect(setStatus.errorCode).toBe('invalid_transition');
  });

  it('returns permission_denied when worker updates other worker item', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'Owned by worker-01',
        assigneeWorkerId: 'finger-worker-01',
      },
    }, systemCtx);
    const item = created.item as PlanItemV2;

    const worker2Ctx = {
      invocationId: 't-worker-2',
      cwd: '/repo/a',
      timestamp: new Date().toISOString(),
      agentId: 'finger-worker-02',
      sessionId: 'session-worker-2',
    };
    const res = await updatePlanTool.execute({
      action: 'update',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: item.revision,
      patch: { description: 'cannot write' },
    }, worker2Ctx);

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('permission_denied');
  });

  it('returns scope_mismatch when non-system agent writes outside cwd project scope', async () => {
    const workerCtx = {
      invocationId: 't-worker-scope',
      cwd: '/repo/a',
      timestamp: new Date().toISOString(),
      agentId: 'finger-worker-01',
      sessionId: 'session-worker-1',
    };
    const res = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: {
        title: 'cross scope create',
        assigneeWorkerId: 'finger-worker-01',
      },
    }, workerCtx);

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('scope_mismatch');
  });

  it('allows system list/search across all projects when projectPath is omitted', async () => {
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'A-1', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'B-1', assigneeWorkerId: 'finger-worker-02' },
    }, { ...systemCtx, cwd: '/repo/b' });

    const listed = await updatePlanTool.execute({
      action: 'list',
    }, systemCtx);
    expect(listed.ok).toBe(true);
    expect(listed.projectPath).toBe('all');
    expect(listed.items).toHaveLength(2);

    const searched = await updatePlanTool.execute({
      action: 'search',
      query: 'B-1',
    }, systemCtx);
    expect(searched.ok).toBe(true);
    expect(searched.projectPath).toBe('all');
    expect(searched.items).toHaveLength(1);
  });

  it('worker list only returns active items in current project scope', async () => {
    const createA = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'closed-item', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    const item = createA.item as PlanItemV2;
    const toInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: item.revision,
      status: 'in_progress',
    }, systemCtx);
    const toReview = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toInProgress.item as PlanItemV2).revision,
      status: 'review_pending',
    }, systemCtx);
    const withEvidence = await updatePlanTool.execute({
      action: 'append_evidence',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toReview.item as PlanItemV2).revision,
      evidence: {
        type: 'test',
        content: 'close path evidence',
      },
    }, systemCtx);
    const toDone = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (withEvidence.item as PlanItemV2).revision,
      status: 'done',
    }, systemCtx);
    expect(toDone.ok).toBe(true);
    await updatePlanTool.execute({
      action: 'close',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toDone.item as PlanItemV2).revision,
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'open-item', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'other-project-item', assigneeWorkerId: 'finger-worker-01' },
    }, { ...systemCtx, cwd: '/repo/b' });

    const workerCtx = {
      invocationId: 'worker-list',
      cwd: '/repo/a',
      timestamp: new Date().toISOString(),
      agentId: 'finger-worker-01',
      sessionId: 'w1',
    };
    const listed = await updatePlanTool.execute({
      action: 'list',
      projectPath: '/repo/a',
    }, workerCtx);
    expect(listed.ok).toBe(true);
    expect(listed.items?.every((row) => row.projectPath === '/repo/a')).toBe(true);
    expect(listed.items?.some((row) => row.status === 'closed')).toBe(false);
    expect(listed.items?.some((row) => row.title === 'open-item')).toBe(true);
  });

  it('blocks transition to in_progress when blockedBy dependency is unresolved', async () => {
    const blocker = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'blocker-task', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    const blocked = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'blocked-task',
        assigneeWorkerId: 'finger-worker-01',
        blockedBy: [String(blocker.item?.id)],
      },
    }, systemCtx);

    const blockedItem = blocked.item as PlanItemV2;
    const setStatus = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: blockedItem.id,
      expectedRevision: blockedItem.revision,
      status: 'in_progress',
    }, systemCtx);

    expect(setStatus.ok).toBe(false);
    expect(setStatus.errorCode).toBe('invalid_transition');
  });

  it('rejects blockedBy value mixing none and concrete dependencies', async () => {
    const res = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: {
        title: 'bad-deps',
        assigneeWorkerId: 'finger-worker-01',
        blockedBy: ['none', 'task-123'],
      },
    }, systemCtx);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('validation_error');
  });

  it('requires evidence for review_pending -> done transition', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'review-required', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    const item = created.item as PlanItemV2;
    const toInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: item.revision,
      status: 'in_progress',
    }, systemCtx);
    const toReview = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toInProgress.item as PlanItemV2).revision,
      status: 'review_pending',
    }, systemCtx);
    const toDoneWithoutEvidence = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toReview.item as PlanItemV2).revision,
      status: 'done',
    }, systemCtx);

    expect(toDoneWithoutEvidence.ok).toBe(false);
    expect(toDoneWithoutEvidence.errorCode).toBe('validation_error');

    const withEvidence = await updatePlanTool.execute({
      action: 'append_evidence',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (toReview.item as PlanItemV2).revision,
      evidence: {
        type: 'test',
        content: 'unit test passed',
      },
    }, systemCtx);
    expect(withEvidence.ok).toBe(true);

    const toDone = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: item.id,
      expectedRevision: (withEvidence.item as PlanItemV2).revision,
      status: 'done',
    }, systemCtx);
    expect(toDone.ok).toBe(true);
  });

  it('records plan events on create and status updates', async () => {
    const created = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'evented-task', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    expect(created.planEvent?.action).toBe('create');

    const toInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: created.item?.id,
      expectedRevision: created.item?.revision,
      status: 'in_progress',
    }, systemCtx);
    expect(toInProgress.planEvent?.action).toBe('set_status');
    expect(toInProgress.planEvent?.statusTo).toBe('in_progress');

    const listed = await updatePlanTool.execute({
      action: 'list',
      projectPath: '/repo/a',
    }, systemCtx);
    expect(Array.isArray(listed.events)).toBe(true);
    expect((listed.events ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('getUpdatePlanRuntimeView returns global active view for system role', async () => {
    const closed = await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'closed-by-view', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    const closedItem = closed.item as PlanItemV2;
    const toInProgress = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: closedItem.id,
      expectedRevision: closedItem.revision,
      status: 'in_progress',
    }, systemCtx);
    const toReview = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: closedItem.id,
      expectedRevision: (toInProgress.item as PlanItemV2).revision,
      status: 'review_pending',
    }, systemCtx);
    const withEvidence = await updatePlanTool.execute({
      action: 'append_evidence',
      projectPath: '/repo/a',
      id: closedItem.id,
      expectedRevision: (toReview.item as PlanItemV2).revision,
      evidence: { type: 'test', content: 'ok' },
    }, systemCtx);
    const toDone = await updatePlanTool.execute({
      action: 'set_status',
      projectPath: '/repo/a',
      id: closedItem.id,
      expectedRevision: (withEvidence.item as PlanItemV2).revision,
      status: 'done',
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'close',
      projectPath: '/repo/a',
      id: closedItem.id,
      expectedRevision: (toDone.item as PlanItemV2).revision,
    }, systemCtx);

    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'active-a', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'active-b', assigneeWorkerId: 'finger-worker-02' },
    }, { ...systemCtx, cwd: '/repo/b' });

    const view = getUpdatePlanRuntimeView({
      agentId: 'finger-system-agent',
      maxItems: 20,
      maxEvents: 20,
    });
    expect(view.actorRole).toBe('system');
    expect(view.scope).toBe('all');
    expect(view.items.some((row) => row.title === 'active-a')).toBe(true);
    expect(view.items.some((row) => row.title === 'active-b')).toBe(true);
    expect(view.items.some((row) => row.status === 'closed')).toBe(false);
  });

  it('getUpdatePlanRuntimeView scopes worker view to project path', async () => {
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'worker-visible', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'worker-hidden', assigneeWorkerId: 'finger-worker-01' },
    }, { ...systemCtx, cwd: '/repo/b' });

    const view = getUpdatePlanRuntimeView({
      agentId: 'finger-project-agent',
      cwd: '/repo/a',
      projectPath: '/repo/a',
      maxItems: 20,
      maxEvents: 20,
    });

    expect(view.actorRole).toBe('worker');
    expect(view.scope).toBe('/repo/a');
    expect(view.items.some((row) => row.title === 'worker-visible')).toBe(true);
    expect(view.items.some((row) => row.title === 'worker-hidden')).toBe(false);
  });
});
