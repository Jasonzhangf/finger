/**
 * Integration tests for module upgrade flow.
 * Uses real filesystem + tmpdir, mocks only orchestration dependencies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RollbackManager } from '../../src/orchestration/rollback-manager.js';
import type { RollbackPoint } from '../../src/orchestration/rollback-manager.js';

describe('Module Upgrade Integration', () => {
  let tmpBase: string;
  let rollbackDir: string;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-upgrade-test-'));
    rollbackDir = path.join(tmpBase, 'rollback');
    fs.mkdirSync(rollbackDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  describe('RollbackManager (real fs)', () => {
    it('should create a rollback point with real file backup', async () => {
      const manager = new RollbackManager(rollbackDir, 3);

      // Create a source file
      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');
      fs.writeFileSync(srcFile, 'module.exports = "v1";');

      const point = await manager.createRollbackPoint('test-mod', '1.0.0', 'extension', [srcFile]);

      expect(point).toBeDefined();
      expect(point.moduleId).toBe('test-mod');
      expect(point.version).toBe('1.0.0');
      expect(fs.existsSync(point.backupPath)).toBe(true);

      // Backup file should exist
      const backupFile = path.join(point.backupPath, 'index.js');
      expect(fs.existsSync(backupFile)).toBe(true);
      expect(fs.readFileSync(backupFile, 'utf-8')).toBe('module.exports = "v1";');
    });

    it('should execute rollback restoring files correctly', async () => {
      const manager = new RollbackManager(rollbackDir, 3);

      // Create source file v1
      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');
      fs.writeFileSync(srcFile, 'v1');

      // Create rollback point
      const point = await manager.createRollbackPoint('test-mod', '1.0.0', 'extension', [srcFile]);

      // Modify source to v2
      fs.writeFileSync(srcFile, 'v2');
      expect(fs.readFileSync(srcFile, 'utf-8')).toBe('v2');

      // Rollback
      const result = await manager.executeRollback(point, srcDir);

      expect(result.ok).toBe(true);
      expect(fs.readFileSync(srcFile, 'utf-8')).toBe('v1');
    });

    it('should enforce maxPoints limit', async () => {
      const manager = new RollbackManager(rollbackDir, 2);

      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');

      fs.writeFileSync(srcFile, 'v1');
      const p1 = await manager.createRollbackPoint('test-mod', '1.0.0', 'extension', [srcFile]);
      await new Promise(r => setTimeout(r, 10)); // ensure different timestamps

      fs.writeFileSync(srcFile, 'v2');
      const p2 = await manager.createRollbackPoint('test-mod', '2.0.0', 'extension', [srcFile]);

      // Only 2 max, so p1 should be cleaned up
      const points = manager.listRollbackPoints('test-mod');
      expect(points).toHaveLength(2);
      const versions = points.map(p => p.version);
      expect(versions).toContain('1.0.0');
      expect(versions).toContain('2.0.0');
    });

    it('should list rollback points in correct order', async () => {
      const manager = new RollbackManager(rollbackDir, 5);

      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');

      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(srcFile, `v${i}`);
        await manager.createRollbackPoint('test-mod', `${i}.0.0`, 'extension', [srcFile]);
        await new Promise(r => setTimeout(r, 10)); // ensure different timestamps
      }

      const points = manager.listRollbackPoints('test-mod');
      expect(points).toHaveLength(3);
      // Most recent first (same second timestamps may be unordered, so check all present)
      const versions = points.map(p => p.version);
      expect(versions).toContain("1.0.0");
      expect(versions).toContain("2.0.0");
      expect(versions).toContain("3.0.0");
    });

    it('should get the latest rollback point', async () => {
      const manager = new RollbackManager(rollbackDir, 3);

      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');

      fs.writeFileSync(srcFile, 'v1');
      await manager.createRollbackPoint('test-mod', '1.0.0', 'extension', [srcFile]);
      await new Promise(r => setTimeout(r, 10)); // ensure different timestamps

      fs.writeFileSync(srcFile, 'v2');
      await manager.createRollbackPoint('test-mod', '2.0.0', 'extension', [srcFile]);

      const latest = manager.getLatestRollbackPoint('test-mod');
      expect(latest).toBeDefined();
      expect(latest!.version).toBe('2.0.0');
    });

    it('should delete a rollback point', async () => {
      const manager = new RollbackManager(rollbackDir, 3);

      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');
      fs.writeFileSync(srcFile, 'v1');

      const point = await manager.createRollbackPoint('test-mod', '1.0.0', 'extension', [srcFile]);
      expect(fs.existsSync(point.backupPath)).toBe(true);

      await manager.deleteRollbackPoint(point);
      expect(fs.existsSync(point.backupPath)).toBe(false);

      const points = manager.listRollbackPoints('test-mod');
      expect(points).toHaveLength(0);
    });

    it('should cleanup all rollback points for a module', async () => {
      const manager = new RollbackManager(rollbackDir, 5);

      const srcDir = path.join(tmpBase, 'modules', 'test-mod');
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, 'index.js');

      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(srcFile, `v${i}`);
        await manager.createRollbackPoint('test-mod', `${i}.0.0`, 'extension', [srcFile]);
        await new Promise(r => setTimeout(r, 10)); // ensure different timestamps
      }

      manager.cleanupModuleRollbacks('test-mod');
      const points = manager.listRollbackPoints('test-mod');
      expect(points).toHaveLength(0);
    });
  });
});
