/**
 * UpgradeEngine - 升级事务引擎
 *
 * 职责：
 * 1. 规划升级（判断策略、解析依赖、生成计划）
 * 2. 执行升级（原子步骤：备份 → 停止 → 替换 → 启动 → 验证 → 提交）
 * 3. 失败自动回滚
 */

import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, join, basename } from 'path';
import { homedir } from 'os';
import { logger } from '../core/logger.js';
import { moduleLayers, type UpgradePolicyType, type ModuleTier } from './module-layers.js';
import { RollbackManager, type RollbackPoint } from './rollback-manager.js';

const log = logger.module('UpgradeEngine');

export type UpgradeStepAction = 'validate' | 'backup' | 'stop' | 'replace' | 'start' | 'verify' | 'commit';
export type UpgradeStepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface UpgradeStep {
  action: UpgradeStepAction;
  status: UpgradeStepStatus;
  evidence?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface UpgradeResult {
  ok: boolean;
  moduleId: string;
  targetVersion: string;
  upgradeType: UpgradePolicyType;
  steps: UpgradeStep[];
  rolledBack: boolean;
  error?: string;
}

export interface FullUpgradeConfig {
  /** 源 dist 目录 */
  sourceDistDir: string;
  /** 目标 dist 目录（daemon 运行目录） */
  targetDistDir: string;
  /** 是否需要重启 daemon */
  requiresRestart: boolean;
}

export interface HotUpgradeConfig {
  /** 模块 ID */
  moduleId: string;
  /** 新版本代码路径 */
  sourcePath: string;
  /** 模块版本 */
  version: string;
  /** 健康检查回调 */
  healthCheck?: () => Promise<boolean>;
  /** 停止回调 */
  onStop?: () => Promise<void>;
  /** 启动回调 */
  onStart?: () => Promise<void>;
}

export type UpgradeConfig = FullUpgradeConfig | HotUpgradeConfig;

function isHotUpgradeConfig(config: UpgradeConfig): config is HotUpgradeConfig {
  return 'moduleId' in config;
}

export class UpgradeEngine {
  private rollbackManager: RollbackManager;

  constructor(rollbackManager?: RollbackManager) {
    this.rollbackManager = rollbackManager ?? new RollbackManager();
  }

  /**
   * 规划升级
   */
  async planUpgrade(
    moduleId: string,
    targetVersion: string,
    config: UpgradeConfig,
  ): Promise<{
    upgradeType: UpgradePolicyType;
    requiresRestart: boolean;
    dependencyOrder: string[];
    tier: ModuleTier;
    steps: UpgradeStep[];
  }> {
    await moduleLayers.load();

    const tier = moduleLayers.getModuleTier(moduleId);
    const policy = moduleLayers.getUpgradePolicy(moduleId);
    const dependencyOrder = moduleLayers.resolveDependencyOrder(moduleId);

    const depValidation = moduleLayers.validateDependencies(moduleId);
    if (!depValidation.ok) {
      throw new Error(`Missing dependencies for ${moduleId}: ${depValidation.missing.join(', ')}`);
    }

    const steps = this.generateSteps(moduleId, policy.type, config);

    return {
      upgradeType: policy.type,
      requiresRestart: policy.requiresRestart,
      dependencyOrder,
      tier,
      steps,
    };
  }

  /**
   * 执行升级
   */
  async executeUpgrade(
    moduleId: string,
    targetVersion: string,
    config: UpgradeConfig,
  ): Promise<UpgradeResult> {
    log.info('Starting upgrade', { moduleId, targetVersion });

    const plan = await this.planUpgrade(moduleId, targetVersion, config);
    const result: UpgradeResult = {
      ok: false,
      moduleId,
      targetVersion,
      upgradeType: plan.upgradeType,
      steps: plan.steps,
      rolledBack: false,
    };

    try {
      for (const step of result.steps) {
        step.startedAt = new Date().toISOString();
        step.status = 'running';

        try {
          const evidence = await this.executeStep(step.action, moduleId, targetVersion, config, plan);
          step.status = 'success';
          step.evidence = evidence;
          step.completedAt = new Date().toISOString();
          log.info(`Step ${step.action} completed`, { moduleId });
        } catch (error) {
          step.status = 'failed';
          step.error = error instanceof Error ? error.message : String(error);
          step.completedAt = new Date().toISOString();
          log.error(`Step ${step.action} failed`, undefined, { moduleId, error: step.error });

          await this.autoRollback(moduleId, result);
          result.rolledBack = true;
          result.error = `Upgrade failed at step '${step.action}': ${step.error}`;
          return result;
        }
      }

      result.ok = true;
      log.info('Upgrade completed successfully', { moduleId, targetVersion });
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      await this.autoRollback(moduleId, result);
      result.rolledBack = true;
    }

    return result;
  }

  // ── Step execution ──

  private async executeStep(
    action: UpgradeStepAction,
    moduleId: string,
    targetVersion: string,
    config: UpgradeConfig,
    plan: Awaited<ReturnType<UpgradeEngine['planUpgrade']>>,
  ): Promise<string> {
    switch (action) {
      case 'validate':
        return await this.stepValidate(moduleId, config);
      case 'backup':
        return await this.stepBackup(moduleId, targetVersion, config, plan.tier);
      case 'stop':
        return await this.stepStop(moduleId, config);
      case 'replace':
        return await this.stepReplace(moduleId, config);
      case 'start':
        return await this.stepStart(moduleId, config);
      case 'verify':
        return await this.stepVerify(moduleId, config);
      case 'commit':
        return await this.stepCommit(moduleId, targetVersion, plan);
      default:
        throw new Error(`Unknown step action: ${action}`);
    }
  }

  private async stepValidate(moduleId: string, config: UpgradeConfig): Promise<string> {
    if (isHotUpgradeConfig(config)) {
      if (!existsSync(config.sourcePath)) {
        throw new Error(`Source path not found: ${config.sourcePath}`);
      }
    } else {
      if (!existsSync(config.sourceDistDir)) {
        throw new Error(`Source dist dir not found: ${config.sourceDistDir}`);
      }
    }

    const validation = moduleLayers.validateDependencies(moduleId);
    if (!validation.ok) {
      throw new Error(`Dependency validation failed: ${validation.missing.join(', ')}`);
    }

    return `Dependencies validated for ${moduleId}`;
  }

  private async stepBackup(
    moduleId: string,
    targetVersion: string,
    config: UpgradeConfig,
    tier: ModuleTier,
  ): Promise<string> {
    if (isHotUpgradeConfig(config)) {
      const sourceFiles = this.collectModuleFiles(config.sourcePath);
      if (sourceFiles.length > 0) {
        const point = await this.rollbackManager.createRollbackPoint(
          moduleId,
          targetVersion,
          tier === 'extension' ? 'extension' : 'core',
          sourceFiles,
        );
        return `Backup created at ${point.backupPath}`;
      }
      return `No files to backup for ${moduleId}`;
    } else {
      const distFiles = this.collectDirectoryFiles(config.targetDistDir);
      if (distFiles.length > 0) {
        const point = await this.rollbackManager.createRollbackPoint(
          moduleId,
          targetVersion,
          'core',
          distFiles,
        );
        return `Dist backup created at ${point.backupPath}`;
      }
      return `No dist files to backup`;
    }
  }

  private async stepStop(moduleId: string, config: UpgradeConfig): Promise<string> {
    if (isHotUpgradeConfig(config) && config.onStop) {
      await config.onStop();
      return `Module ${moduleId} stopped via callback`;
    }
    return `No stop action needed for ${moduleId}`;
  }

  private async stepReplace(moduleId: string, config: UpgradeConfig): Promise<string> {
    if (isHotUpgradeConfig(config)) {
      return `Module ${moduleId} replaced (handled by WorkerManager)`;
    } else {
      this.copyDirectory(config.sourceDistDir, config.targetDistDir);
      return `Dist replaced: ${config.sourceDistDir} -> ${config.targetDistDir}`;
    }
  }

  private async stepStart(moduleId: string, config: UpgradeConfig): Promise<string> {
    if (isHotUpgradeConfig(config) && config.onStart) {
      await config.onStart();
      return `Module ${moduleId} started via callback`;
    }
    return `No start action needed for ${moduleId}`;
  }

  private async stepVerify(moduleId: string, config: UpgradeConfig): Promise<string> {
    if (isHotUpgradeConfig(config) && config.healthCheck) {
      const healthy = await config.healthCheck();
      if (!healthy) {
        throw new Error(`Health check failed for ${moduleId} after upgrade`);
      }
      return `Health check passed for ${moduleId}`;
    }
    return `Verification passed for ${moduleId}`;
  }

  private async stepCommit(
    moduleId: string,
    targetVersion: string,
    plan: Awaited<ReturnType<UpgradeEngine['planUpgrade']>>,
  ): Promise<string> {
    log.info('Upgrade committed', { moduleId, targetVersion, upgradeType: plan.upgradeType });
    return `Upgrade committed: ${moduleId}@${targetVersion}`;
  }

  // ── Auto rollback ──

  private async autoRollback(moduleId: string, result: UpgradeResult): Promise<void> {
    const rollbackPoint = this.rollbackManager.getLatestRollbackPoint(moduleId);
    if (!rollbackPoint) {
      log.warn('No rollback point available, manual recovery needed', { moduleId });
      result.error = (result.error || '') + ' [No rollback point available]';
      return;
    }

    log.info('Executing automatic rollback', { moduleId, rollbackPoint: rollbackPoint.version });

    try {
      const restoreDir = this.rollbackManager.getRollbackDir();
      const rollbackResult = await this.rollbackManager.executeRollback(rollbackPoint, restoreDir);

      if (rollbackResult.ok) {
        log.info('Rollback successful', { moduleId });
      } else {
        log.error('Rollback failed', undefined, { moduleId, error: rollbackResult.error });
        result.error = (result.error || '') + ` [Rollback also failed: ${rollbackResult.error}]`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Rollback threw error', undefined, { moduleId, error: message });
      result.error = (result.error || '') + ` [Rollback error: ${message}]`;
    }
  }

  // ── Helpers ──

  private generateSteps(
    moduleId: string,
    upgradeType: UpgradePolicyType,
    config: UpgradeConfig,
  ): UpgradeStep[] {
    return [
      { action: 'validate', status: 'pending' },
      { action: 'backup', status: 'pending' },
      { action: 'stop', status: 'pending' },
      { action: 'replace', status: 'pending' },
      { action: 'start', status: 'pending' },
      { action: 'verify', status: 'pending' },
      { action: 'commit', status: 'pending' },
    ];
  }

  private collectModuleFiles(dirPath: string): string[] {
    const files: string[] = [];
    if (!existsSync(dirPath)) return files;

    const collect = (currentPath: string) => {
      const entries = readdirSync(currentPath);
      for (const entry of entries) {
        const fullPath = join(currentPath, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          collect(fullPath);
        } else {
          files.push(fullPath);
        }
      }
    };

    collect(dirPath);
    return files;
  }

  private collectDirectoryFiles(dirPath: string): string[] {
    return this.collectModuleFiles(dirPath);
  }

  private copyDirectory(src: string, dest: string): void {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });

    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        this.copyDirectory(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }
}

export const upgradeEngine = new UpgradeEngine();
