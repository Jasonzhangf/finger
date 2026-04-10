import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteWorkflowFile,
  isTaskTimeout,
  isWorkflowCompleted,
  loadAllWorkflows,
  loadWorkflow,
  saveWorkflow,
  WORKFLOWS_DIR,
} from '../../../src/orchestration/workflow-persistence.js';
import type { Workflow, TaskNode } from '../../../src/orchestration/workflow-manager.js';

const workflows = new Map<string, Workflow>();
const files = new Map<string, string>();

vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn((target) => {
      const path = String(target);
      if (path.endsWith('.json')) {
        return files.has(path);
      }
      return true; // Always return true for directory checks
    }),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn((filePath, content) => {
      files.set(String(filePath), String(content));
      const workflowId = String(filePath).split('/').pop()?.replace('.json', '');
      if (workflowId) {
        const parsed = JSON.parse(String(content));
        workflows.set(workflowId, {
          ...parsed,
          tasks: new Map(parsed.tasks || []),
        });
      }
    }),
    readFileSync: vi.fn((filePath) => {
      const key = String(filePath);
      if (key.endsWith('agents.json') || key.endsWith('orchestration.json')) {
        return '{}';
      }
      const content = files.get(key);
      if (content === undefined) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return content;
    }),
    unlinkSync: vi.fn((filePath) => {
      files.delete(String(filePath));
      const workflowId = String(filePath).split('/').pop()?.replace('.json', '');
      if (workflowId) {
        workflows.delete(workflowId);
      }
    }),
    readdirSync: vi.fn((dir) => {
      if (String(dir) === WORKFLOWS_DIR) {
        return Array.from(files.keys())
          .filter((f) => f.endsWith('.json') && f.startsWith(WORKFLOWS_DIR))
          .map((f) => f.split('/').pop()!);
      }
      return [];
    }),
  };
  return {
    default: fsMock,
    ...fsMock,
  };
});

function createWorkflow(
  id: string,
  status: Workflow['status'] = 'planning',
  tasks: Map<string, TaskNode> = new Map(),
): Workflow {
  return {
    id,
    sessionId: `session-${id}`,
    userTask: `Task for ${id}`,
    tasks,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('workflow-persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflows.clear();
    files.clear();
  });

  describe('saveWorkflow', () => {
    it('saves workflow to file', () => {
      const workflow = createWorkflow('wf-1', 'planning');
      expect(() => saveWorkflow(workflow)).not.toThrow();
    });

    it('saves with epicId and context when provided', () => {
      const workflow: Workflow = {
        ...createWorkflow('wf-2'),
        epicId: 'epic-1',
        context: { key: 'value' },
      };
      saveWorkflow(workflow);
      expect(workflows.has('wf-2')).toBe(true);
    });

    it('serializes tasks map correctly', () => {
      const tasks = new Map<string, TaskNode>();
      tasks.set('task-1', {
        id: 'task-1',
        description: 'Test task',
        type: 'executor',
        status: 'pending',
        dependencies: [],
        dependents: [],
      });
      const workflow = createWorkflow('wf-3', 'executing', tasks);
      saveWorkflow(workflow);
      expect(workflows.has('wf-3')).toBe(true);
    });
  });

  describe('loadWorkflow', () => {
    it('returns null for non-existent workflow', () => {
      const result = loadWorkflow('nonexistent');
      expect(result).toBeNull();
    });

    it('loads saved workflow', () => {
      const workflow = createWorkflow('wf-4', 'planning');
      saveWorkflow(workflow);
      const loaded = loadWorkflow('wf-4');
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe('wf-4');
    });

    it('returns null on parse error', () => {
      files.set(`${WORKFLOWS_DIR}/bad.json`, 'not valid json');
      const result = loadWorkflow('bad');
      expect(result).toBeNull();
    });
  });

  describe('loadAllWorkflows', () => {
    it('returns empty array when no workflows', () => {
      const result = loadAllWorkflows();
      expect(result).toEqual([]);
    });

    it('loads all uncompleted workflows', () => {
      saveWorkflow(createWorkflow('wf-5', 'planning'));
      saveWorkflow(createWorkflow('wf-6', 'executing'));
      saveWorkflow(createWorkflow('wf-7', 'completed'));
      const result = loadAllWorkflows();
      expect(result.length).toBe(2);
      expect(result.map((w) => w.id).sort()).toEqual(['wf-5', 'wf-6']);
    });

    it('excludes failed workflows', () => {
      saveWorkflow(createWorkflow('wf-8', 'failed'));
      const result = loadAllWorkflows();
      expect(result.find((w) => w.id === 'wf-8')).toBeUndefined();
    });
  });

  describe('deleteWorkflowFile', () => {
    it('does not throw for non-existent workflow', () => {
      expect(() => deleteWorkflowFile('nonexistent')).not.toThrow();
    });

    it('deletes existing workflow file', () => {
      saveWorkflow(createWorkflow('wf-9'));
      deleteWorkflowFile('wf-9');
      expect(loadWorkflow('wf-9')).toBeNull();
    });
  });

  describe('isWorkflowCompleted', () => {
    it('returns true for completed status', () => {
      expect(isWorkflowCompleted(createWorkflow('x', 'completed'))).toBe(true);
    });

    it('returns true for failed status', () => {
      expect(isWorkflowCompleted(createWorkflow('x', 'failed'))).toBe(true);
    });

    it('returns false for other statuses', () => {
      expect(isWorkflowCompleted(createWorkflow('x', 'planning'))).toBe(false);
      expect(isWorkflowCompleted(createWorkflow('x', 'executing'))).toBe(false);
      expect(isWorkflowCompleted(createWorkflow('x', 'paused'))).toBe(false);
    });
  });

  describe('isTaskTimeout', () => {
    it('returns false for task not in progress', () => {
      const task: TaskNode = {
        id: 't1',
        description: 'test',
        type: 'executor',
        status: 'pending',
        dependencies: [],
        dependents: [],
      };
      expect(isTaskTimeout(task)).toBe(false);
    });

    it('returns false for task without startedAt', () => {
      const task: TaskNode = {
        id: 't2',
        description: 'test',
        type: 'executor',
        status: 'in_progress',
        dependencies: [],
        dependents: [],
      };
      expect(isTaskTimeout(task)).toBe(false);
    });

    it('returns false for task without deadline', () => {
      const task: TaskNode = {
        id: 't3',
        description: 'test',
        type: 'executor',
        status: 'in_progress',
        startedAt: new Date(Date.now() - 100).toISOString(),
        dependencies: [],
        dependents: [],
      };
      expect(isTaskTimeout(task)).toBe(false);
    });

    it('returns true when deadline exceeded', () => {
      const task: TaskNode = {
        id: 't4',
        description: 'test',
        type: 'executor',
        status: 'in_progress',
        startedAt: new Date(Date.now() - 2000).toISOString(),
        deadline: 1000,
        dependencies: [],
        dependents: [],
      };
      expect(isTaskTimeout(task)).toBe(true);
    });
  });

  describe('WORKFLOWS_DIR', () => {
    it('exports workflow directory path', () => {
      expect(WORKFLOWS_DIR).toContain('workflows');
    });
  });
});
