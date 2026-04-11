/**
 * RollbackManager - 升级回滚管理器
 *
 * 职责：
 * 1. 管理回滚点创建与存储
 * 2. 执行回滚操作
 * 3. 自动清理过期回滚点
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  copyFileSync,
  statSync,
  renameSync,
} from 'fs';
import { resolve, join, basename } from 'path';
import { homedir } from 'os';
import { logger } from '../core/logger.js';

const log = logger.module('RollbackManager');

export interface RollbackPoint {
  moduleId: string;
  version: string;
  tier: 'core' | 'extension';
  backupPath: string;
  createdAt: string; // ISO8601
  snapshotFiles: string[];
}

export interface RollbackManifest {
  points: RollbackPoint[];
  maxPoints: number;
}

export class RollbackManager {
  private rollbackDir: string;
  private manifestPath: string;
  private manifest: RollbackManifest;

  constructor(basePath?: string, maxPoints = 3) {
    this.rollbackDir = basePath
      ? resolve(basePath)
      : resolve(homedir(), '.finger', 'rollback');
    this.manifestPath = join(this.rollbackDir, 'rollback-manifest.json');
    this.manifest = this.loadManifest();
    this.manifest.maxPoints = maxPoints;

    // Ensure directory structure exists
    mkdirSync(join(this.rollbackDir, 'core'), { recursive: true });
    mkdirSync(join(this.rollbackDir, 'extension'), { recursive: true });
  }

  /**
   * 创建回滚点
   */
  async createRollbackPoint(
    moduleId: string,
    version: string,
    tier: 'core' | 'extension',
    sourceFiles: string[],
  ): Promise<RollbackPoint> {
    const tierDir = join(this.rollbackDir, tier);
    const moduleDir = join(tierDir, moduleId);
    const backupName = `${version}.bak.${Date.now()}`;
    const backupPath = join(moduleDir, backupName);

    mkdirSync(backupPath, { recursive: true });

    const snapshotFiles: string[] = [];

    for (const srcFile of sourceFiles) {
      if (!existsSync(srcFile)) {
        log.warn('Source file not found for rollback snapshot', { srcFile });
        continue;
      }

      const relativePath = basename(srcFile);
      const destPath = join(backupPath, relativePath);
      copyFileSync(srcFile, destPath);
      snapshotFiles.push(relativePath);
    }

    const point: RollbackPoint = {
      moduleId,
      version,
      tier,
      backupPath,
      createdAt: new Date().toISOString(),
      snapshotFiles,
    };

    this.manifest.points.push(point);
    this.saveManifest();

    log.info('Rollback point created', {
      moduleId,
      version,
      tier,
      backupPath,
      fileCount: snapshotFiles.length,
    });

    // Enforce max points
    this.enforceMaxPoints(moduleId);

    return point;
  }

  /**
   * 列出模块的回滚点
   */
  listRollbackPoints(moduleId: string): RollbackPoint[] {
    return this.manifest.points
      .filter((p) => p.moduleId === moduleId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * 获取最近的回滚点
   */
  getLatestRollbackPoint(moduleId: string): RollbackPoint | undefined {
    const points = this.listRollbackPoints(moduleId);
    return points.length > 0 ? points[0] : undefined;
  }

  /**
   * 执行回滚
   */
  async executeRollback(
    rollbackPoint: RollbackPoint,
    restoreTargetDir: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!existsSync(rollbackPoint.backupPath)) {
      return { ok: false, error: `Backup path not found: ${rollbackPoint.backupPath}` };
    }

    try {
      mkdirSync(restoreTargetDir, { recursive: true });

      for (const file of rollbackPoint.snapshotFiles) {
        const srcPath = join(rollbackPoint.backupPath, file);
        const destPath = join(restoreTargetDir, file);
        if (existsSync(srcPath)) {
          copyFileSync(srcPath, destPath);
          log.info('Restored file', { file, destPath });
        }
      }

      // Mark point as rolled back
      const idx = this.manifest.points.findIndex(
        (p) => p.moduleId === rollbackPoint.moduleId && p.createdAt === rollbackPoint.createdAt,
      );
      if (idx >= 0) {
        this.manifest.points.splice(idx, 1);
        this.saveManifest();
      }

      log.info('Rollback executed successfully', {
        moduleId: rollbackPoint.moduleId,
        version: rollbackPoint.version,
        restoreTargetDir,
      });

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Rollback failed', undefined, {
        moduleId: rollbackPoint.moduleId,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  /**
   * 删除指定回滚点
   */
  async deleteRollbackPoint(point: RollbackPoint): Promise<void> {
    if (existsSync(point.backupPath)) {
      rmSync(point.backupPath, { recursive: true, force: true });
    }

    const idx = this.manifest.points.findIndex(
      (p) => p.moduleId === point.moduleId && p.createdAt === point.createdAt,
    );
    if (idx >= 0) {
      this.manifest.points.splice(idx, 1);
      this.saveManifest();
    }

    log.info('Rollback point deleted', {
      moduleId: point.moduleId,
      version: point.version,
    });
  }

  /**
   * 清理模块的所有回滚点
   */
  cleanupModuleRollbacks(moduleId: string): void {
    const points = this.listRollbackPoints(moduleId);
    for (const point of points) {
      void this.deleteRollbackPoint(point);
    }
  }


  /**
   * 获取回滚根目录（供外部使用）
   */
  getRollbackDir(): string {
    return this.rollbackDir;
  }

  // ── Private ──

  private loadManifest(): RollbackManifest {
    if (existsSync(this.manifestPath)) {
      try {
        const raw = readFileSync(this.manifestPath, 'utf-8');
        return JSON.parse(raw) as RollbackManifest;
      } catch {
        return { points: [], maxPoints: 3 };
      }
    }
    return { points: [], maxPoints: 3 };
  }

  private saveManifest(): void {
    mkdirSync(dirnameSafe(this.manifestPath), { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8');
  }

  private enforceMaxPoints(moduleId: string): void {
    const tier = this.manifest.points.find((p) => p.moduleId === moduleId)?.tier;
    if (!tier) return;

    const modulePoints = this.listRollbackPoints(moduleId);
    const maxPoints = this.manifest.maxPoints;

    if (modulePoints.length > maxPoints) {
      const excess = modulePoints.slice(maxPoints);
      for (const point of excess) {
        void this.deleteRollbackPoint(point);
      }
      log.info('Enforced max rollback points', { moduleId, maxPoints, removed: excess.length });
    }
  }
}

function dirnameSafe(p: string): string {
  return p.substring(0, p.lastIndexOf('/'));
}
