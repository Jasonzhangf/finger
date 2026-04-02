import { describe, expect, it } from 'vitest';
import {
  mergeProjectTaskState,
  parseProjectTaskState,
  parseDelegatedProjectTaskRegistry,
  upsertDelegatedProjectTaskRegistry,
} from '../../../src/common/project-task-state.js';

describe('project-task-state name fields', () => {
  it('parses name fields from projectTaskState payload', () => {
    const parsed = parseProjectTaskState({
      active: true,
      status: 'dispatched',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      assigner_name: 'Mirror',
      assignee_worker_id: 'finger-worker-01',
      assignee_worker_name: 'Lisa',
      reviewer_id: 'finger-reviewer',
      reviewer_name: 'Sentinel-A',
      updatedAt: '2026-04-02T12:00:00.000Z',
    });
    expect(parsed?.assignerName).toBe('Mirror');
    expect(parsed?.assigneeWorkerName).toBe('Lisa');
    expect(parsed?.reviewerName).toBe('Sentinel-A');
  });

  it('merges name fields into next task state', () => {
    const merged = mergeProjectTaskState(null, {
      active: true,
      status: 'create',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      assignerName: 'Mirror',
      assigneeWorkerId: 'finger-worker-01',
      assigneeWorkerName: 'Lisa',
    });
    expect(merged.assignerName).toBe('Mirror');
    expect(merged.assigneeWorkerName).toBe('Lisa');
  });

  it('upserts delegated registry with assigner/assignee names', () => {
    const registry = upsertDelegatedProjectTaskRegistry([], {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      assignerName: 'Mirror',
      assigneeWorkerId: 'finger-worker-01',
      assigneeWorkerName: 'Lisa',
      taskId: 'task-1',
      taskName: 'Fix dispatch naming',
      status: 'dispatched',
      active: true,
    });
    expect(registry[0]?.assignerName).toBe('Mirror');
    expect(registry[0]?.assigneeWorkerName).toBe('Lisa');

    const reparsed = parseDelegatedProjectTaskRegistry([
      {
        key: 'finger-project-agent:task-1:Fix_dispatch_naming',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'dispatched',
        active: true,
        updatedAt: new Date().toISOString(),
        assigner_name: 'Mirror',
        assignee_worker_name: 'Lisa',
      },
    ]);
    expect(reparsed[0]?.assignerName).toBe('Mirror');
    expect(reparsed[0]?.assigneeWorkerName).toBe('Lisa');
  });
});
