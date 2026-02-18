import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { BdTools } from '../../../src/agents/shared/bd-tools.js';

// Mock child_process for spawn-based bd runner
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();

  const createSpawnMock = (args: string[]) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
      pid: number;
    };

    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => undefined;
    child.pid = 12345;

    const fullArgs = args.join(' ');

    setTimeout(() => {
      if (fullArgs.includes('create')) {
        stdout.emit('data', Buffer.from('Created task: finger-100\nfinger-100\n'));
      } else if (fullArgs.includes('show')) {
        stdout.emit('data', Buffer.from(JSON.stringify({
          id: 'finger-100',
          title: 'Test Task',
          status: 'open',
          priority: 1,
          labels: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
        })));
      } else if (fullArgs.includes('list')) {
        stdout.emit('data', Buffer.from('[]'));
      } else {
        stdout.emit('data', Buffer.from(''));
      }
      child.emit('close', 0);
    }, 0);

    return child;
  };

  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[]) => createSpawnMock(args)),
  };
});

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
