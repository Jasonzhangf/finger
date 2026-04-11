/**
 * BD Epic View 集成测试
 * 
 * 测试目标：
 * 1. getCandidateEpics 按 priority 升序 + updatedAt 降序排序
 * 2. getCurrentEpic 获取指定 epic
 * 3. getNextEpic 选择下一个候选 epic
 * 4. 边界情况处理
 * 
 * 注意：由于 bd CLI 需要正确的初始化环境，这里使用 mock spawnSync
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock spawnSync before importing bd-epic-view
const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: any[]) => spawnSyncMock(...args),
}));

// Import after mock
const bdEpicView = await import('../../../src/server/modules/bd-epic-view.js');

describe('BD Epic View Integration Tests', () => {
  let testBeadsDir: string;
  let testBdStorePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    spawnSyncMock.mockReset();
    
    // 创建临时测试目录和文件（让真实的 existsSync 通过）
    testBeadsDir = path.join(os.tmpdir(), `finger-bd-test-${Date.now()}`);
    fs.mkdirSync(testBeadsDir, { recursive: true });
    testBdStorePath = path.join(testBeadsDir, 'issues.jsonl');
    fs.writeFileSync(testBdStorePath, ''); // 创建空文件
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testBeadsDir)) {
      fs.rmSync(testBeadsDir, { recursive: true, force: true });
    }
  });

  describe('getCandidateEpics 排序', () => {
    it('按 priority 升序 + updatedAt 降序排序', () => {
      // Mock bd list output
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'bd' && args.includes('--json') && args.includes('list')) {
          const epics = [
            { id: 'epic-a', title: 'Epic A', status: 'open', priority: 1, updatedAt: '2026-01-01T10:00:00Z' },
            { id: 'epic-b', title: 'Epic B', status: 'open', priority: 1, updatedAt: '2026-01-02T10:00:00Z' },
            { id: 'epic-c', title: 'Epic C', status: 'open', priority: 0, updatedAt: '2026-01-01T10:00:00Z' },
            { id: 'epic-done', title: 'Epic Done', status: 'done', priority: 0 },
            { id: 'epic-blocked', title: 'Epic Blocked', status: 'blocked', priority: 0 },
          ];
          return { status: 0, stdout: JSON.stringify(epics), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'not found' };
      });

      const candidates = bdEpicView.getCandidateEpics(testBdStorePath, 10);

      // 应该只返回 open
      expect(candidates.length).toBe(3);
      // 排序：priority 升序，updatedAt 降序
      expect(candidates[0].id).toBe('epic-c'); // priority 0
      expect(candidates[1].id).toBe('epic-b'); // priority 1, updatedAt 更晚
      expect(candidates[2].id).toBe('epic-a'); // priority 1, updatedAt 更早
    });
  });

  describe('getCurrentEpic', () => {
    it('返回指定的 epic 及其任务状态', () => {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'bd' && args.includes('show')) {
          return {
            status: 0,
            stdout: JSON.stringify({ id: 'epic-current', title: 'Current Epic', status: 'in_progress', priority: 0, updatedAt: '2026-01-01' }),
            stderr: '',
          };
        }
        if (cmd === 'bd' && args.includes('--parent')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 'task-1', title: 'Task 1', status: 'done', priority: 1 },
              { id: 'task-2', title: 'Task 2', status: 'in_progress', priority: 2 },
              { id: 'task-3', title: 'Task 3', status: 'open', priority: 0 },
            ]),
            stderr: '',
          };
        }
        return { status: 1, stdout: '', stderr: 'not found' };
      });

      const epic = bdEpicView.getCurrentEpic(testBdStorePath, 'epic-current');

      expect(epic).toBeDefined();
      expect(epic?.id).toBe('epic-current');
      expect(epic?.status).toBe('in_progress');
      expect(epic?.progress.total).toBe(3);
      expect(epic?.progress.completed).toBe(1);
      expect(epic?.currentTaskId).toBe('task-2');
      expect(epic?.nextTaskId).toBe('task-3');
    });

    it('返回 null 当 epic 不存在', () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: '', stderr: 'not found', error: new Error('not found') });

      const epic = bdEpicView.getCurrentEpic(testBdStorePath, 'epic-not-exist');

      expect(epic).toBeNull();
    });
  });

  describe('getNextEpic', () => {
    it('选择下一个候选 epic', () => {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'bd' && args.includes('list')) {
          const epics = [
            { id: 'epic-done', title: 'Done Epic', status: 'done', priority: 0 },
            { id: 'epic-next', title: 'Next Epic', status: 'open', priority: 0, updatedAt: '2026-01-02T10:00:00Z' },
            { id: 'epic-other', title: 'Other Epic', status: 'open', priority: 1, updatedAt: '2026-01-01T10:00:00Z' },
          ];
          return { status: 0, stdout: JSON.stringify(epics), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'not found' };
      });

      const next = bdEpicView.getNextEpic(testBdStorePath, 'epic-done');

      expect(next).toBeDefined();
      expect(next?.id).toBe('epic-next');
    });

    it('返回 null 当无候选 epic', () => {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'bd' && args.includes('list')) {
          const epics = [
            { id: 'epic-1', title: 'Epic 1', status: 'blocked', priority: 0 },
            { id: 'epic-2', title: 'Epic 2', status: 'done', priority: 0 },
          ];
          return { status: 0, stdout: JSON.stringify(epics), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'not found' };
      });

      const next = bdEpicView.getNextEpic(testBdStorePath, 'epic-2');

      expect(next).toBeNull();
    });
  });

  describe('getEpicTaskState', () => {
    it('返回当前任务状态', () => {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'bd' && args.includes('list') && args.includes('--parent')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { id: 'task-1', title: 'Task 1', status: 'done' },
              { id: 'task-2', title: 'Task 2', status: 'in_progress' },
              { id: 'task-3', title: 'Task 3', status: 'open' },
              { id: 'task-4', title: 'Task 4', status: 'blocked' },
            ]),
            stderr: '',
          };
        }
        return { status: 0, stdout: JSON.stringify([]), stderr: '' };
      });

      const state = bdEpicView.getEpicTaskState(testBdStorePath, 'epic-with-tasks');

      expect(state).toBeDefined();
      expect(state?.currentTask?.id).toBe('task-2');
      expect(state?.nextTask?.id).toBe('task-3');
      expect(state?.hasBlocked).toBe(true);
    });
  });

  describe('边界情况', () => {
    it('getCandidateEpics 文件不存在返回空数组', () => {
      // 不创建文件，让真实的 existsSync 返回 false
      const nonExistPath = '/non/exist/path/issues.jsonl';
      const candidates = bdEpicView.getCandidateEpics(nonExistPath, 10);
      expect(candidates).toEqual([]);
    });
  });
});
