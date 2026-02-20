import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveWorkflow, loadWorkflow, loadAllWorkflows, deleteWorkflowFile, isWorkflowCompleted, isTaskTimeout } from '../../../src/orchestration/workflow-persistence.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{}'),
  unlinkSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
  },
  homedir: vi.fn(() => '/home/test'),
}));

describe('workflow-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('saveWorkflow', () => {
    it('should save workflow to file', () => {
      const workflow = {
        id: 'wf-1',
        sessionId: 's1',
        userTask: 'Test',
        tasks: new Map(),
        status: 'planning' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      
      expect(() => saveWorkflow(workflow)).not.toThrow();
    });
  });

  describe('loadWorkflow', () => {
    it('should return null for non-existent workflow', () => {
      const workflow = loadWorkflow('nonexistent');
      expect(workflow).toBeNull();
    });
  });

  describe('loadAllWorkflows', () => {
    it('should return empty array when no workflows', () => {
      const workflows = loadAllWorkflows();
      expect(workflows).toEqual([]);
    });
  });

  describe('deleteWorkflowFile', () => {
    it('should not throw for non-existent workflow', () => {
      expect(() => deleteWorkflowFile('nonexistent')).not.toThrow();
    });
  });

  describe('isWorkflowCompleted', () => {
    it('should return true for completed workflow', () => {
      const workflow = {
        id: 'wf-1',
        sessionId: 's1',
        userTask: 'Test',
        tasks: new Map(),
        status: 'completed' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(isWorkflowCompleted(workflow)).toBe(true);
    });

    it('should return false for non-completed workflow', () => {
      const workflow = {
        id: 'wf-1',
        sessionId: 's1',
        userTask: 'Test',
        tasks: new Map(),
        status: 'executing' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(isWorkflowCompleted(workflow)).toBe(false);
    });
  });

  describe('isTaskTimeout', () => {
    it('should return false for task without deadline', () => {
      const task = {
        id: 't1',
        description: 'Test',
        type: 'executor' as const,
        status: 'in_progress' as const,
        dependencies: [],
        dependents: [],
      };
      expect(isTaskTimeout(task)).toBe(false);
    });

    it('should return true for timed out task', () => {
      // deadline = max time allowed, so deadline = 1 means 1ms max
      const task = {
        id: 't1',
        description: 'Test',
        type: 'executor' as const,
        status: 'in_progress' as const,
        dependencies: [],
        dependents: [],
        deadline: 1, // 1ms max allowed, started 10s ago -> definitely timed out
        startedAt: new Date(Date.now() - 10000).toISOString(),
      };
      expect(isTaskTimeout(task)).toBe(true);
    });
  });
});
