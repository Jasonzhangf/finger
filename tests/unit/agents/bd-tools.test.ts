import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BdTools } from '../../../src/agents/shared/bd-tools.js';

// Mock exec
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _options: any, callback: any) => {
    // 模拟 bd CLI 响应
    if (cmd.includes('bd --no-db create')) {
      callback(null, { stdout: 'Created task: finger-100\nfinger-100' });
    } else if (cmd.includes('bd --no-db ready')) {
      callback(null, { stdout: '[]' });
    } else if (cmd.includes('bd --no-db show')) {
      callback(null, { stdout: JSON.stringify({
        id: 'finger-100',
        title: 'Test Task',
        status: 'open',
        priority: 1,
        labels: [],
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      }) });
    } else if (cmd.includes('bd --no-db list --parent')) {
      callback(null, { stdout: '[]' });
    } else {
      callback(null, { stdout: '' });
    }
  }),
}));

describe('BdTools', () => {
  let bdTools: BdTools;

  beforeEach(() => {
    bdTools = new BdTools('/test/cwd');
    vi.clearAllMocks();
  });

  describe('createTask', () => {
    it('should create a task and return parsed result', async () => {
      const result = await bdTools.createTask({
        title: 'Test Task',
        type: 'task',
        priority: 1,
      });

      expect(result.id).toBe('finger-100');
      expect(result.title).toBe('Test Task');
      expect(result.status).toBe('open');
    });

    it('should create an epic with labels', async () => {
      const result = await bdTools.createTask({
        title: 'Test Epic',
        type: 'epic',
        priority: 0,
        labels: ['orchestration'],
      });

      expect(result.id).toBe('finger-100');
      expect(result.labels).toContain('orchestration');
    });
  });

  describe('updateStatus', () => {
    it('should call bd update with status', async () => {
      await expect(bdTools.updateStatus('finger-100', 'in_progress')).resolves.not.toThrow();
    });
  });

  describe('assignTask', () => {
    it('should call bd update with assignee', async () => {
      await expect(bdTools.assignTask('finger-100', 'executor-1')).resolves.not.toThrow();
    });
  });

  describe('addComment', () => {
    it('should add comment with escaped quotes', async () => {
      await expect(
        bdTools.addComment('finger-100', 'Test with "quotes"')
      ).resolves.not.toThrow();
    });
  });

  describe('closeTask', () => {
    it('should close task with reason and deliverables', async () => {
      await expect(
        bdTools.closeTask('finger-100', 'Done', [
          { type: 'file', path: '/src/test.ts', checksum: 'abc123' },
          { type: 'result', content: 'Success' },
        ])
      ).resolves.not.toThrow();
    });
  });

  describe('addDependency', () => {
    it('should add dependency between tasks', async () => {
      await expect(
        bdTools.addDependency('finger-100', 'finger-99')
      ).resolves.not.toThrow();
    });
  });

  describe('getTask', () => {
    it('should return parsed task', async () => {
      const result = await bdTools.getTask('finger-100');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('finger-100');
      expect(result?.title).toBe('Test Task');
    });
  });

  describe('getEpicProgress', () => {
    it('should return progress stats', async () => {
      const result = await bdTools.getEpicProgress('finger-100');
      expect(result).toEqual({
        total: 0,
        completed: 0,
        inProgress: 0,
        blocked: 0,
        open: 0,
      });
    });
  });

  describe('blockTask', () => {
    it('should update status and add comment', async () => {
      await expect(
        bdTools.blockTask('finger-100', 'Waiting for dependency')
      ).resolves.not.toThrow();
    });
  });

  describe('createChangeRequest', () => {
    it('should create change request task', async () => {
      const result = await bdTools.createChangeRequest(
        'Change requirements',
        'finger-50',
        'User feedback'
      );
      expect(result.id).toBe('finger-100');
    });
  });
});
