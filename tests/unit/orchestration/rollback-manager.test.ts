import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
  copyFileSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('fs', () => fsMocks);

vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

import { RollbackManager } from '../../../src/orchestration/rollback-manager.js';
import type { RollbackPoint } from '../../../src/orchestration/rollback-manager.js';

describe('RollbackManager', () => {
  let manager: RollbackManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: manifest does not exist
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue(JSON.stringify({ points: [], maxPoints: 3 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default basePath', () => {
      manager = new RollbackManager();
      expect(manager.getRollbackDir()).toBe('/home/test/.finger/rollback');
    });

    it('should initialize with custom basePath and maxPoints', () => {
      manager = new RollbackManager('/tmp/rollback-test', 5);
      expect(manager.getRollbackDir()).toBe('/tmp/rollback-test');
    });

    it('should create directory structure on construction', () => {
      manager = new RollbackManager('/tmp/test');
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(
        '/tmp/test/core',
        { recursive: true },
      );
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith(
        '/tmp/test/extension',
        { recursive: true },
      );
    });
  });

  describe('createRollbackPoint()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should create a rollback point and save manifest', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      const point = await manager.createRollbackPoint(
        'kernel',
        '1.0.0',
        'core',
        ['/tmp/src/kernel.js', '/tmp/src/kernel.d.ts'],
      );

      expect(point.moduleId).toBe('kernel');
      expect(point.version).toBe('1.0.0');
      expect(point.tier).toBe('core');
      expect(point.snapshotFiles).toHaveLength(2);
      expect(point.snapshotFiles).toContain('kernel.js');
      expect(point.snapshotFiles).toContain('kernel.d.ts');
      expect(fsMocks.mkdirSync).toHaveBeenCalled();
      expect(fsMocks.copyFileSync).toHaveBeenCalledTimes(2);
      expect(fsMocks.writeFileSync).toHaveBeenCalled(); // saveManifest
    });

    it('should skip source files that do not exist', async () => {
      fsMocks.existsSync
        .mockReturnValueOnce(false) // first file missing
        .mockReturnValueOnce(true); // second file exists

      const point = await manager.createRollbackPoint(
        'kernel',
        '1.0.0',
        'core',
        ['/tmp/src/missing.js', '/tmp/src/existing.js'],
      );

      expect(point.snapshotFiles).toHaveLength(1);
      expect(point.snapshotFiles).toContain('existing.js');
    });

    it('should handle empty source file list', async () => {
      const point = await manager.createRollbackPoint(
        'kernel',
        '1.0.0',
        'core',
        [],
      );

      expect(point.snapshotFiles).toEqual([]);
    });
  });

  describe('listRollbackPoints()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should return empty array when no points exist', () => {
      const points = manager.listRollbackPoints('kernel');
      expect(points).toEqual([]);
    });

    it('should return points sorted by createdAt descending', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);

      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '2.0.0', 'core', ['/tmp/b.js']);

      vi.setSystemTime(new Date('2024-01-03T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '3.0.0', 'core', ['/tmp/c.js']);

      vi.useRealTimers();

      const points = manager.listRollbackPoints('kernel');
      expect(points).toHaveLength(3);
      expect(points[0].version).toBe('3.0.0');
      expect(points[1].version).toBe('2.0.0');
      expect(points[2].version).toBe('1.0.0');
    });

    it('should only return points for the specified module', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      await manager.createRollbackPoint('extension-a', '1.0.0', 'extension', ['/tmp/b.js']);

      const kernelPoints = manager.listRollbackPoints('kernel');
      expect(kernelPoints).toHaveLength(1);
      expect(kernelPoints[0].moduleId).toBe('kernel');
    });
  });

  describe('getLatestRollbackPoint()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should return undefined when no points exist', () => {
      const point = manager.getLatestRollbackPoint('kernel');
      expect(point).toBeUndefined();
    });

    it('should return the most recent rollback point', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '2.0.0', 'core', ['/tmp/b.js']);
      vi.useRealTimers();

      const latest = manager.getLatestRollbackPoint('kernel');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('2.0.0');
    });
  });

  describe('executeRollback()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should restore files from rollback point', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      const point: RollbackPoint = {
        moduleId: 'kernel',
        version: '1.0.0',
        tier: 'core',
        backupPath: '/tmp/rollback/core/kernel/1.0.0.bak.1000',
        createdAt: '2024-01-01T00:00:00.000Z',
        snapshotFiles: ['kernel.js', 'kernel.d.ts'],
      };

      const result = await manager.executeRollback(point, '/tmp/restore');

      expect(result.ok).toBe(true);
      expect(fsMocks.mkdirSync).toHaveBeenCalledWith('/tmp/restore', { recursive: true });
      expect(fsMocks.copyFileSync).toHaveBeenCalledWith(
        '/tmp/rollback/core/kernel/1.0.0.bak.1000/kernel.js',
        '/tmp/restore/kernel.js',
      );
      expect(fsMocks.copyFileSync).toHaveBeenCalledWith(
        '/tmp/rollback/core/kernel/1.0.0.bak.1000/kernel.d.ts',
        '/tmp/restore/kernel.d.ts',
      );
    });

    it('should return error when backup path does not exist', async () => {
      fsMocks.existsSync.mockReturnValue(false);

      const point: RollbackPoint = {
        moduleId: 'kernel',
        version: '1.0.0',
        tier: 'core',
        backupPath: '/tmp/missing-backup',
        createdAt: '2024-01-01T00:00:00.000Z',
        snapshotFiles: ['kernel.js'],
      };

      const result = await manager.executeRollback(point, '/tmp/restore');

      expect(result.ok).toBe(false);
      expect(result.error).toContain('Backup path not found');
    });

    it('should skip missing files during restore', async () => {
      fsMocks.existsSync
        .mockReturnValueOnce(true)  // backupPath exists
        .mockReturnValueOnce(true)  // first file exists
        .mockReturnValueOnce(false); // second file missing

      const point: RollbackPoint = {
        moduleId: 'kernel',
        version: '1.0.0',
        tier: 'core',
        backupPath: '/tmp/rollback/core/kernel/1.0.0.bak.1000',
        createdAt: '2024-01-01T00:00:00.000Z',
        snapshotFiles: ['kernel.js', 'missing.d.ts'],
      };

      const result = await manager.executeRollback(point, '/tmp/restore');
      expect(result.ok).toBe(true);
      expect(fsMocks.copyFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('deleteRollbackPoint()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should delete the backup directory and remove from manifest', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      const createdPoint = await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);

      await manager.deleteRollbackPoint(createdPoint);

      expect(fsMocks.rmSync).toHaveBeenCalled();
      const remaining = manager.listRollbackPoints('kernel');
      expect(remaining).toHaveLength(0);
    });

    it('should not throw if backup path does not exist', async () => {
      fsMocks.existsSync.mockReturnValue(true); // for manifest

      const point: RollbackPoint = {
        moduleId: 'kernel',
        version: '1.0.0',
        tier: 'core',
        backupPath: '/tmp/already-deleted',
        createdAt: '2024-01-01T00:00:00.000Z',
        snapshotFiles: [],
      };

      await expect(manager.deleteRollbackPoint(point)).resolves.not.toThrow();
    });
  });

  describe('cleanupModuleRollbacks()', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 3);
    });

    it('should remove all rollback points for a module', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '2.0.0', 'core', ['/tmp/b.js']);
      vi.setSystemTime(new Date('2024-01-03T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '3.0.0', 'core', ['/tmp/c.js']);

      vi.useRealTimers();

      expect(manager.listRollbackPoints('kernel')).toHaveLength(3);

      manager.cleanupModuleRollbacks('kernel');

      expect(manager.listRollbackPoints('kernel')).toHaveLength(0);
      expect(fsMocks.rmSync).toHaveBeenCalled();
    });

    it('should not affect other modules', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      await manager.createRollbackPoint('extension-a', '1.0.0', 'extension', ['/tmp/b.js']);

      manager.cleanupModuleRollbacks('kernel');

      expect(manager.listRollbackPoints('kernel')).toHaveLength(0);
      expect(manager.listRollbackPoints('extension-a')).toHaveLength(1);
    });
  });

  describe('enforceMaxPoints (maxPoints limit)', () => {
    beforeEach(() => {
      manager = new RollbackManager('/tmp/rollback', 2);
    });

    it('should enforce maxPoints and remove excess rollback points', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      vi.setSystemTime(new Date('2024-01-02T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '2.0.0', 'core', ['/tmp/b.js']);
      vi.setSystemTime(new Date('2024-01-03T00:00:00Z'));
      await manager.createRollbackPoint('kernel', '3.0.0', 'core', ['/tmp/c.js']);

      vi.useRealTimers();

      const points = manager.listRollbackPoints('kernel');
      expect(points).toHaveLength(2);
      expect(points[0].version).toBe('3.0.0');
      expect(points[1].version).toBe('2.0.0');
    });

    it('should not remove points when under limit', async () => {
      fsMocks.existsSync.mockReturnValue(true);

      await manager.createRollbackPoint('kernel', '1.0.0', 'core', ['/tmp/a.js']);
      await manager.createRollbackPoint('kernel', '2.0.0', 'core', ['/tmp/b.js']);

      const points = manager.listRollbackPoints('kernel');
      expect(points).toHaveLength(2);
    });
  });

  describe('getRollbackDir()', () => {
    it('should return the rollback directory path', () => {
      manager = new RollbackManager('/custom/rollback');
      expect(manager.getRollbackDir()).toBe('/custom/rollback');
    });
  });
});
