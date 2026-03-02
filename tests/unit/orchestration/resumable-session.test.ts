import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResumableSessionManager, TaskProgress, SessionCheckpoint, determineResumePhase } from '../../../src/orchestration/resumable-session.js';

// Mock fs module
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '[]'),
    readdirSync: vi.fn(() => []),
    unlinkSync: vi.fn(),
  };
  return {
    default: fsMock,
    ...fsMock,
  };
});

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
  homedir: vi.fn(() => '/home/test'),
}));

describe('ResumableSessionManager', () => {
  let manager: ResumableSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ResumableSessionManager();
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(manager).toBeDefined();
    });
  });

  describe('createCheckpoint', () => {
    it('should create checkpoint', () => {
      const taskProgress: TaskProgress[] = [
        {
          taskId: 't1',
          description: 'Task 1',
          status: 'pending',
          iterationCount: 0,
          maxIterations: 10,
        },
      ];

      const checkpoint = manager.createCheckpoint(
        'session-1',
        'Test task',
        taskProgress,
        {},
        {}
      );

      expect(checkpoint).toBeDefined();
      expect(checkpoint.sessionId).toBe('session-1');
      expect(checkpoint.originalTask).toBe('Test task');
      expect(checkpoint.taskProgress.length).toBe(1);
    });

    it('should track completed and pending tasks', () => {
      const taskProgress: TaskProgress[] = [
        { taskId: 't1', description: 'Task 1', status: 'completed', iterationCount: 1, maxIterations: 10 },
        { taskId: 't2', description: 'Task 2', status: 'pending', iterationCount: 0, maxIterations: 10 },
      ];

      const checkpoint = manager.createCheckpoint('session-1', 'Test', taskProgress, {}, {});
      expect(checkpoint.completedTaskIds).toContain('t1');
      expect(checkpoint.pendingTaskIds).toContain('t2');
    });
  });

  describe('updateSession', () => {
    it('should not throw', () => {
      expect(() => manager.updateSession('session-1', { name: 'Test' })).not.toThrow();
    });
  });

  describe('loadCheckpoint', () => {
    it('should return null for non-existent checkpoint', () => {
      const checkpoint = manager.loadCheckpoint('nonexistent');
      expect(checkpoint).toBeNull();
    });
  });

  describe('findLatestCheckpoint', () => {
    it('should return null when no checkpoints exist', () => {
      const checkpoint = manager.findLatestCheckpoint('session-1');
      expect(checkpoint).toBeNull();
    });
  });

  describe('buildResumeContext', () => {
    it('should build resume context from checkpoint', () => {
      const checkpoint = manager.createCheckpoint('session-1', 'Test task', [
        { taskId: 't1', description: 'Task 1', status: 'completed', iterationCount: 1, maxIterations: 10 },
        { taskId: 't2', description: 'Task 2', status: 'pending', iterationCount: 0, maxIterations: 10 },
      ], {}, {});

      const context = manager.buildResumeContext(checkpoint);
      expect(context.summary).toContain('Test task');
      expect(context.estimatedProgress).toBe(50); // 1/2 completed
      expect(context.nextActions.length).toBeGreaterThan(0);
    });
  });

  describe('cleanupOldCheckpoints', () => {
    it('should return 0 for non-existent session', () => {
      const deleted = manager.cleanupOldCheckpoints('nonexistent');
      expect(deleted).toBe(0);
    });
  });
});

describe('determineResumePhase', () => {
  it('should return plan phase for failed tasks', () => {
    const checkpoint: SessionCheckpoint = {
      checkpointId: 'cp-1',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      originalTask: 'Test',
      taskProgress: [
        { taskId: 't1', description: 'Task 1', status: 'failed', iterationCount: 1, maxIterations: 10 },
      ],
      completedTaskIds: [],
      failedTaskIds: ['t1'],
      pendingTaskIds: [],
      agentStates: {},
      context: {},
    };

    expect(determineResumePhase(checkpoint)).toBe('plan');
  });

  it('should return verify phase when all tasks completed', () => {
    const checkpoint: SessionCheckpoint = {
      checkpointId: 'cp-2',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      originalTask: 'Test',
      taskProgress: [
        { taskId: 't1', description: 'Task 1', status: 'completed', iterationCount: 1, maxIterations: 10 },
      ],
      completedTaskIds: ['t1'],
      failedTaskIds: [],
      pendingTaskIds: [],
      agentStates: {},
      context: {},
    };

    expect(determineResumePhase(checkpoint)).toBe('verify');
  });

  it('should return parallel_dispatch for in-progress tasks', () => {
    const checkpoint: SessionCheckpoint = {
      checkpointId: 'cp-3',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      originalTask: 'Test',
      taskProgress: [
        { taskId: 't1', description: 'Task 1', status: 'in_progress', iterationCount: 1, maxIterations: 10 },
      ],
      completedTaskIds: [],
      failedTaskIds: [],
      pendingTaskIds: ['t1'],
      agentStates: {},
      context: {},
    };

    expect(determineResumePhase(checkpoint)).toBe('parallel_dispatch');
  });
});
