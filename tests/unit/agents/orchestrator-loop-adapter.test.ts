import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../dist/orchestration/loop/index.js', () => ({
  loopManager: {
    createLoop: vi.fn(() => ({ id: 'loop-1' })),
    startLoop: vi.fn(),
    addNode: vi.fn(),
    completeLoop: vi.fn(),
    transitionPhase: vi.fn(),
  },
}));

describe('orchestrator-loop-adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps task status to loop node status', () => {
    expect(toLoopNodeStatus('pending')).toBe('waiting');
    expect(toLoopNodeStatus('ready')).toBe('waiting');
    expect(toLoopNodeStatus('in_progress')).toBe('running');
    expect(toLoopNodeStatus('completed')).toBe('done');
    expect(toLoopNodeStatus('failed')).toBe('failed');
  });

  it('creates plan loop and initial node', () => {
    const loopId = createPlanLoop('epic-1', 'long user task');
    expect(loopId).toBe('loop-1');
  });
});
