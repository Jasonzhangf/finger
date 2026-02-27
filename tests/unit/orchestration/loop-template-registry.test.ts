import { describe, expect, it } from 'vitest';
import { recommendLoopTemplates } from '../../../src/orchestration/loop/loop-template-registry.js';

describe('recommendLoopTemplates', () => {
  it('classifies evidence tasks into search_evidence template', () => {
    const result = recommendLoopTemplates({
      task: 'Search latest benchmark papers and collect evidence sources',
    });
    expect(result.primaryTemplate).toBe('search_evidence');
    expect(result.taskSuggestions[0].template).toBe('search_evidence');
  });

  it('splits blocking and non-blocking tasks', () => {
    const result = recommendLoopTemplates({
      tasks: [
        { id: 't1', description: 'Implement module A' },
        { id: 't2', description: 'Integrate module B after module A', blockedBy: ['t1'] },
      ],
    });
    expect(result.nonBlockingTaskIds).toEqual(['t1']);
    expect(result.blockingTaskIds).toEqual(['t2']);
  });

  it('marks high-context tasks as context isolation required', () => {
    const result = recommendLoopTemplates({
      task: 'Cross-module refactor for multi-file architecture change',
      contextConsumption: 'high',
    });
    expect(result.taskSuggestions[0].contextIsolationRequired).toBe(true);
  });

  it('prefers parallel_execution when most tasks are parallel friendly', () => {
    const result = recommendLoopTemplates({
      tasks: [
        { id: 't1', description: 'Implement endpoint A' },
        { id: 't2', description: 'Implement endpoint B' },
        { id: 't3', description: 'Implement endpoint C' },
      ],
    });
    expect(result.primaryTemplate).toBe('parallel_execution');
  });
});
