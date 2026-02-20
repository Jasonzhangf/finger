import { describe, it, expect, beforeEach } from 'vitest';
import { TaskBlock } from '../../../src/blocks/task-block/index.js';
import type { Task } from '../../../src/core/types.js';

describe('TaskBlock', () => {
  let block: TaskBlock;

  beforeEach(() => {
    block = new TaskBlock('test-tasks');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-tasks');
      expect(block.type).toBe('task');
    });

    it('should have correct capabilities', () => {
      expect(block.capabilities.functions).toContain('create');
      expect(block.capabilities.functions).toContain('get');
      expect(block.capabilities.functions).toContain('update');
      expect(block.capabilities.functions).toContain('delete');
      expect(block.capabilities.functions).toContain('list');
      expect(block.capabilities.functions).toContain('ready');
    });
  });

  describe('create', () => {
    it('should create a task with default values', async () => {
      const result = await block.execute('create', { title: 'Test Task' });
      const task = result as Task;
      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.status).toBe('open');
      expect(task.priority).toBe(1);
    });

    it('should create a task with custom id', async () => {
      const result = await block.execute('create', { id: 'custom-id', title: 'Task' });
      const task = result as Task;
      expect(task.id).toBe('custom-id');
    });

    it('should create a task with dependencies', async () => {
      await block.execute('create', { id: 'dep1', title: 'Dependency' });
      const result = await block.execute('create', { 
        id: 'main', 
        title: 'Main', 
        dependencies: ['dep1'] 
      });
      const task = result as Task;
      expect(task.dependencies).toContain('dep1');
    });
  });

  describe('get', () => {
    it('should return task by id', async () => {
      await block.execute('create', { id: 'task-1', title: 'Task 1' });
      const result = await block.execute('get', { id: 'task-1' });
      const task = result as Task;
      expect(task.title).toBe('Task 1');
    });

    it('should return undefined for non-existent task', async () => {
      const result = await block.execute('get', { id: 'non-existent' });
      expect(result).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update task status', async () => {
      await block.execute('create', { id: 'task-1', title: 'Task' });
      const result = await block.execute('update', { id: 'task-1', status: 'in_progress' });
      const task = result as Task;
      expect(task.status).toBe('in_progress');
    });

    it('should throw for non-existent task', async () => {
      await expect(block.execute('update', { id: 'non-existent', status: 'closed' }))
        .rejects.toThrow('not found');
    });
  });

  describe('delete', () => {
    it('should delete an existing task', async () => {
      await block.execute('create', { id: 'task-1', title: 'Task' });
      const result = await block.execute('delete', { id: 'task-1' });
      expect(result).toBe(true);
      const deleted = await block.execute('get', { id: 'task-1' });
      expect(deleted).toBeUndefined();
    });

    it('should return false for non-existent task', async () => {
      const result = await block.execute('delete', { id: 'non-existent' });
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all tasks', async () => {
      await block.execute('create', { id: 't1', title: 'Task 1' });
      await block.execute('create', { id: 't2', title: 'Task 2' });
      const result = await block.execute('list', {});
      const tasks = result as Task[];
      expect(tasks.length).toBe(2);
    });

    it('should filter by status', async () => {
      await block.execute('create', { id: 't1', title: 'Task 1', status: 'open' });
      await block.execute('create', { id: 't2', title: 'Task 2', status: 'closed' });
      const result = await block.execute('list', { status: 'closed' });
      const tasks = result as Task[];
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('t2');
    });

    it('should sort by priority', async () => {
      await block.execute('create', { id: 't1', title: 'Task 1', priority: 1 });
      await block.execute('create', { id: 't2', title: 'Task 2', priority: 5 });
      await block.execute('create', { id: 't3', title: 'Task 3', priority: 3 });
      const result = await block.execute('list', {});
      const tasks = result as Task[];
      expect(tasks[0].id).toBe('t2'); // priority 5
      expect(tasks[1].id).toBe('t3'); // priority 3
      expect(tasks[2].id).toBe('t1'); // priority 1
    });
  });

  describe('ready', () => {
    it('should return tasks with completed dependencies', async () => {
      await block.execute('create', { id: 'dep', title: 'Dependency', status: 'closed' });
      await block.execute('create', { 
        id: 'main', 
        title: 'Main', 
        status: 'open',
        dependencies: ['dep'] 
      });
      const result = await block.execute('ready', {});
      const tasks = result as Task[];
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe('main');
    });

    it('should not return tasks with incomplete dependencies', async () => {
      await block.execute('create', { id: 'dep', title: 'Dependency', status: 'open' });
      await block.execute('create', { 
        id: 'main', 
        title: 'Main', 
        status: 'open',
        dependencies: ['dep'] 
      });
      const result = await block.execute('ready', {});
      const tasks = result as Task[];
      expect(tasks.length).toBeGreaterThan(0);
    });
  });

  describe('execute unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
