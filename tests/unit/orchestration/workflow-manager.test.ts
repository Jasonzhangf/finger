import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowManager } from '../../../src/orchestration/workflow-manager.js';

// Mock dependencies
vi.mock('../../../src/orchestration/workflow-persistence.js', () => ({
  saveWorkflow: vi.fn(),
  loadWorkflow: vi.fn(),
}));

vi.mock('../../../src/orchestration/resource-pool.js', () => ({
  resourcePool: {
    setResourceBusy: vi.fn(),
  },
}));

vi.mock('../../../src/orchestration/resumable-session.js', () => ({
  resumableSessionManager: {
    createCheckpoint: vi.fn(() => ({ checkpointId: 'cp-1' })),
    findLatestCheckpoint: vi.fn(),
  },
}));

describe('WorkflowManager', () => {
  let manager: WorkflowManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorkflowManager();
  });

  describe('constructor', () => {
    it('should initialize with empty workflows', () => {
      expect(manager.listWorkflows()).toEqual([]);
    });

    it('should initialize with empty resource pool', () => {
      const pool = manager.getResourcePool();
      expect(pool.executors).toEqual([]);
      expect(pool.reviewers).toEqual([]);
      expect(pool.busyAgents.size).toBe(0);
    });
  });

  describe('registerAgent', () => {
    it('should register executor agent', () => {
      manager.registerAgent('executor-1', 'executor');
      const pool = manager.getResourcePool();
      expect(pool.executors).toContain('executor-1');
    });

    it('should register reviewer agent', () => {
      manager.registerAgent('reviewer-1', 'reviewer');
      const pool = manager.getResourcePool();
      expect(pool.reviewers).toContain('reviewer-1');
    });

    it('should register multiple agents', () => {
      manager.registerAgent('exec-1', 'executor');
      manager.registerAgent('exec-2', 'executor');
      const pool = manager.getResourcePool();
      expect(pool.executors.length).toBe(2);
    });
  });

  describe('unregisterAgent', () => {
    it('should unregister executor agent', () => {
      manager.registerAgent('exec-1', 'executor');
      manager.unregisterAgent('exec-1');
      const pool = manager.getResourcePool();
      expect(pool.executors).not.toContain('exec-1');
    });

    it('should remove from busyAgents', () => {
      manager.registerAgent('exec-1', 'executor');
      manager.assignTask('wf-1', 'task-1', 'exec-1');
      manager.unregisterAgent('exec-1');
      const pool = manager.getResourcePool();
      expect(pool.busyAgents.has('exec-1')).toBe(false);
    });
  });

  describe('createWorkflow', () => {
    it('should create workflow with auto-generated ID', () => {
      const wf = manager.createWorkflow();
      expect(wf.id).toMatch(/^workflow-/);
      expect(wf.status).toBe('planning');
    });

    it('should create workflow with specified ID', () => {
      const wf = manager.createWorkflow('wf-test', 'session-1');
      expect(wf.id).toBe('wf-test');
      expect(wf.sessionId).toBe('session-1');
    });

    it('should return existing workflow if ID exists', () => {
      const wf1 = manager.createWorkflow('wf-dup', 's1');
      const wf2 = manager.createWorkflow('wf-dup', 's2');
      expect(wf1.id).toBe(wf2.id);
    });

    it('should create workflow with all parameters', () => {
      const wf = manager.createWorkflow('wf-full', 's1', 'epic-1', 'Do something', 'executing');
      expect(wf.epicId).toBe('epic-1');
      expect(wf.userTask).toBe('Do something');
      expect(wf.status).toBe('executing');
    });
  });

  describe('addTask', () => {
    let workflowId: string;

    beforeEach(() => {
      const wf = manager.createWorkflow('wf-task-test', 's1');
      workflowId = wf.id;
    });

    it('should add task to workflow', () => {
      const task = manager.addTask(workflowId, {
        id: 'task-1',
        description: 'Test task',
        type: 'executor',
        dependencies: [],
      });
      expect(task.id).toBe('task-1');
      expect(task.status).toBe('pending');
    });

    it('should throw for non-existent workflow', () => {
      expect(() => manager.addTask('nonexistent', {
        id: 'task-1',
        description: 'Test',
        type: 'executor',
        dependencies: [],
      })).toThrow('Workflow nonexistent not found');
    });

    it('should link dependents', () => {
      manager.addTask(workflowId, {
        id: 'task-1',
        description: 'First',
        type: 'executor',
        dependencies: [],
      });
      manager.addTask(workflowId, {
        id: 'task-2',
        description: 'Second',
        type: 'executor',
        dependencies: ['task-1'],
      });
      
      const wf = manager.getWorkflow(workflowId)!;
      expect(wf.tasks.get('task-1')?.dependents).toContain('task-2');
    });
  });

  describe('updateTaskStatus', () => {
    let workflowId: string;

    beforeEach(() => {
      const wf = manager.createWorkflow('wf-status-test', 's1');
      workflowId = wf.id;
      manager.addTask(workflowId, {
        id: 'task-1',
        description: 'Test',
        type: 'executor',
        dependencies: [],
      });
      manager.registerAgent('exec-1', 'executor');
      manager.assignTask(workflowId, 'task-1', 'exec-1');
    });

    it('should update task status', () => {
      const result = manager.updateTaskStatus(workflowId, 'task-1', 'in_progress');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow(workflowId)!;
      expect(wf.tasks.get('task-1')?.status).toBe('in_progress');
    });

    it('should set startedAt for in_progress', () => {
      manager.updateTaskStatus(workflowId, 'task-1', 'in_progress');
      
      const wf = manager.getWorkflow(workflowId)!;
      expect(wf.tasks.get('task-1')?.startedAt).toBeDefined();
    });

    it('should set completedAt for completed', () => {
      manager.updateTaskStatus(workflowId, 'task-1', 'completed');
      
      const wf = manager.getWorkflow(workflowId)!;
      expect(wf.tasks.get('task-1')?.completedAt).toBeDefined();
    });

    it('should release agent for completed/failed', () => {
      manager.updateTaskStatus(workflowId, 'task-1', 'completed');
      const pool = manager.getResourcePool();
      expect(pool.busyAgents.has('exec-1')).toBe(false);
    });

    it('should return false for non-existent workflow', () => {
      const result = manager.updateTaskStatus('nonexistent', 'task-1', 'completed');
      expect(result).toBe(false);
    });

    it('should return false for non-existent task', () => {
      const result = manager.updateTaskStatus(workflowId, 'nonexistent', 'completed');
      expect(result).toBe(false);
    });

    it('should update dependent status when task completes', () => {
      manager.addTask(workflowId, {
        id: 'task-2',
        description: 'Dependent task',
        type: 'executor',
        dependencies: ['task-1'],
      });
      
      // First mark task-2 as blocked
      const wf = manager.getWorkflow(workflowId)!;
      wf.tasks.get('task-2')!.status = 'blocked';
      
      manager.updateTaskStatus(workflowId, 'task-1', 'completed');
      
      expect(wf.tasks.get('task-2')?.status).toBe('ready');
    });
  });

  describe('assignTask', () => {
    let workflowId: string;

    beforeEach(() => {
      const wf = manager.createWorkflow('wf-assign-test', 's1');
      workflowId = wf.id;
      manager.addTask(workflowId, {
        id: 'task-1',
        description: 'Test',
        type: 'executor',
        dependencies: [],
      });
    });

    it('should assign agent to task', () => {
      const result = manager.assignTask(workflowId, 'task-1', 'exec-1');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow(workflowId)!;
      expect(wf.tasks.get('task-1')?.assignee).toBe('exec-1');
    });

    it('should add agent to busyAgents', () => {
      manager.assignTask(workflowId, 'task-1', 'exec-1');
      const pool = manager.getResourcePool();
      expect(pool.busyAgents.has('exec-1')).toBe(true);
    });

    it('should return false for non-existent workflow', () => {
      const result = manager.assignTask('nonexistent', 'task-1', 'exec-1');
      expect(result).toBe(false);
    });

    it('should return false for non-existent task', () => {
      const result = manager.assignTask(workflowId, 'nonexistent', 'exec-1');
      expect(result).toBe(false);
    });
  });

  describe('getReadyTasks', () => {
    let workflowId: string;

    beforeEach(() => {
      const wf = manager.createWorkflow('wf-ready-test', 's1');
      workflowId = wf.id;
    });

    it('should return tasks with no dependencies', () => {
      manager.addTask(workflowId, {
        id: 'task-1',
        description: 'No deps',
        type: 'executor',
        dependencies: [],
      });
      
      const ready = manager.getReadyTasks(workflowId);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe('task-1');
    });

    it('should return ready status tasks', () => {
      manager.addTask(workflowId, {
        id: 'task-1',
        description: 'Ready',
        type: 'executor',
        dependencies: [],
      });
      manager.updateTaskStatus(workflowId, 'task-1', 'ready');
      
      const ready = manager.getReadyTasks(workflowId);
      expect(ready.length).toBe(1);
    });

    it('should return empty for non-existent workflow', () => {
      const ready = manager.getReadyTasks('nonexistent');
      expect(ready).toEqual([]);
    });
  });

  describe('getAvailableAgents', () => {
    beforeEach(() => {
      manager.registerAgent('exec-1', 'executor');
      manager.registerAgent('exec-2', 'executor');
      manager.registerAgent('rev-1', 'reviewer');
    });

    it('should return available executors', () => {
      const available = manager.getAvailableAgents('executor');
      expect(available.length).toBe(2);
    });

    it('should return available reviewers', () => {
      const available = manager.getAvailableAgents('reviewer');
      expect(available.length).toBe(1);
    });

    it('should exclude busy agents', () => {
      manager.createWorkflow('wf-avail-test', 's1');
      manager.addTask('wf-avail-test', { id: 't1', description: '', type: 'executor', dependencies: [] });
      manager.assignTask('wf-avail-test', 't1', 'exec-1');
      
      const available = manager.getAvailableAgents('executor');
      expect(available).not.toContain('exec-1');
    });
  });

  describe('getWorkflow', () => {
    it('should return workflow by ID', () => {
      manager.createWorkflow('wf-get-test', 's1');
      const wf = manager.getWorkflow('wf-get-test');
      expect(wf).toBeDefined();
      expect(wf!.id).toBe('wf-get-test');
    });

    it('should return undefined for non-existent', () => {
      const wf = manager.getWorkflow('nonexistent');
      expect(wf).toBeUndefined();
    });
  });

  describe('listWorkflows', () => {
    it('should list all workflows sorted by updatedAt', async () => {
      manager.createWorkflow('wf-list-1', 's1');
      await new Promise(r => setTimeout(r, 10));
      manager.createWorkflow('wf-list-2', 's2');
      
      const list = manager.listWorkflows();
      expect(list.length).toBe(2);
      expect(list[0].id).toBe('wf-list-2');
    });
  });

  describe('pauseWorkflow', () => {
    it('should pause workflow', () => {
      manager.createWorkflow('wf-pause-test', 's1');
      const result = manager.pauseWorkflow('wf-pause-test');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow('wf-pause-test');
      expect(wf!.status).toBe('paused');
    });

    it('should return false for non-existent', () => {
      const result = manager.pauseWorkflow('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('resumeWorkflow', () => {
    it('should resume workflow', () => {
      manager.createWorkflow('wf-resume-test', 's1');
      manager.pauseWorkflow('wf-resume-test');
      const result = manager.resumeWorkflow('wf-resume-test');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow('wf-resume-test');
      expect(wf!.status).toBe('executing');
    });

    it('should return false for non-existent', () => {
      const result = manager.resumeWorkflow('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('updateWorkflowStatus', () => {
    it('should update status', () => {
      manager.createWorkflow('wf-status-upd', 's1');
      const result = manager.updateWorkflowStatus('wf-status-upd', 'executing');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow('wf-status-upd');
      expect(wf!.status).toBe('executing');
    });

    it('should return false for non-existent', () => {
      const result = manager.updateWorkflowStatus('nonexistent', 'executing');
      expect(result).toBe(false);
    });
  });

  describe('updateWorkflowContext', () => {
    it('should update context', () => {
      manager.createWorkflow('wf-ctx', 's1');
      const result = manager.updateWorkflowContext('wf-ctx', { key: 'value' });
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow('wf-ctx');
      expect(wf!.context).toEqual({ key: 'value' });
    });

    it('should merge context', () => {
      manager.createWorkflow('wf-ctx2', 's1');
      manager.updateWorkflowContext('wf-ctx2', { a: 1 });
      manager.updateWorkflowContext('wf-ctx2', { b: 2 });
      
      const wf = manager.getWorkflow('wf-ctx2');
      expect(wf!.context).toEqual({ a: 1, b: 2 });
    });

    it('should return false for non-existent', () => {
      const result = manager.updateWorkflowContext('nonexistent', {});
      expect(result).toBe(false);
    });
  });

  describe('setUserTask', () => {
    it('should set user task', () => {
      manager.createWorkflow('wf-usertask', 's1');
      const result = manager.setUserTask('wf-usertask', 'New task');
      expect(result).toBe(true);
      
      const wf = manager.getWorkflow('wf-usertask');
      expect(wf!.userTask).toBe('New task');
    });

    it('should return false for non-existent', () => {
      const result = manager.setUserTask('nonexistent', 'task');
      expect(result).toBe(false);
    });
  });

  describe('getResourcePool', () => {
    it('should return copy of resource pool', () => {
      manager.registerAgent('exec-1', 'executor');
      const pool = manager.getResourcePool();
      expect(pool.executors).toContain('exec-1');
    });
  });

  describe('createCheckpoint', () => {
    it('should create checkpoint', () => {
      manager.createWorkflow('wf-cp', 's1');
      manager.addTask('wf-cp', { id: 't1', description: '', type: 'executor', dependencies: [] });
      
      const cpId = manager.createCheckpoint('wf-cp');
      expect(cpId).toBe('cp-1');
    });

    it('should return null for non-existent workflow', () => {
      const cpId = manager.createCheckpoint('nonexistent');
      expect(cpId).toBeNull();
    });
  });
});
