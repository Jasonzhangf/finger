import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProjectBlock } from '../../../src/blocks/project-block/index.js';

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd, cb: any) => {
    if (cb) cb(null, { stdout: '', stderr: '' });
    return { on: vi.fn(), kill: vi.fn() };
  }),
  execFile: vi.fn((...args: any[]) => {
    const cb = args.find((arg) => typeof arg === 'function');
    if (cb) cb(null, { stdout: '', stderr: '' });
    return { on: vi.fn(), kill: vi.fn() };
  }),
}));

describe('ProjectBlock', () => {
  let block: ProjectBlock;

  beforeEach(() => {
    vi.clearAllMocks();
    block = new ProjectBlock('test-project');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-project');
      expect(block.type).toBe('project');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('create');
      expect(caps.functions).toContain('get');
      expect(caps.functions).toContain('update');
      expect(caps.functions).toContain('delete');
      expect(caps.functions).toContain('list');
      expect(caps.functions).toContain('sync');
    });
  });

  describe('execute - create', () => {
    it('should create a project', async () => {
      const project: any = await block.execute('create', { name: 'Test Project', description: 'Test' });
      expect(project.id).toBeDefined();
      expect(project.name).toBe('Test Project');
      expect(project.description).toBe('Test');
    });
  });

  describe('execute - get', () => {
    it('should get a project by id', async () => {
      const created: any = await block.execute('create', { name: 'Test' });
      const project = await block.execute('get', { projectId: created.id });
      expect(project).toBeDefined();
      expect((project as any).id).toBe(created.id);
    });

    it('should return undefined for non-existent project', async () => {
      const project = await block.execute('get', { projectId: 'non-existent' });
      expect(project).toBeUndefined();
    });
  });

  describe('execute - list', () => {
    it('should list all projects', async () => {
      const p1: any = await block.execute('create', { name: 'Project 1' });
      const p2: any = await block.execute('create', { name: 'Project 2' });
      const projects = await block.execute('list', {});
      expect(Array.isArray(projects)).toBe(true);
      const projectIds = projects.map((p: any) => p.id);
      expect(projectIds).toContain(p1.id);
      expect(projectIds).toContain(p2.id);
    });
  });

  describe('execute - update', () => {
    it('should update a project', async () => {
      const created: any = await block.execute('create', { name: 'Test' });
      const updated: any = await block.execute('update', {
        projectId: created.id,
        name: 'Updated Name',
      });
      expect(updated.name).toBe('Updated Name');
    });

    it('should throw for non-existent project', async () => {
      await expect(block.execute('update', {
        projectId: 'non-existent',
        name: 'Test',
      })).rejects.toThrow('not found');
    });
  });

  describe('execute - delete', () => {
    it('should delete a project', async () => {
      const created: any = await block.execute('create', { name: 'Test' });
      const result = await block.execute('delete', { projectId: created.id });
      expect(result.deleted).toBe(true);
      const project = await block.execute('get', { projectId: created.id });
      expect(project).toBeUndefined();
    });

    it('should return false for non-existent project', async () => {
      const result = await block.execute('delete', { projectId: 'non-existent' });
      expect(result.deleted).toBe(false);
    });
  });

  describe('execute - sync', () => {
    it('should sync projects to bd', async () => {
      await block.execute('create', { name: 'Test Project' });
      const result = await block.execute('sync', {});
      expect(result.synced).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
