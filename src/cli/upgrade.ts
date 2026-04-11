/**
 * Upgrade CLI Command - 模块升级命令行接口
 *
 * 支持：
 * - finger upgrade run <module-id> - 升级指定模块
 * - finger upgrade run <module-id> --version <target> - 升级到指定版本
 * - finger upgrade all - 升级所有 Extension 模块
 * - finger upgrade core - 升级 Core 层（需确认 + daemon 重启）
 * - finger upgrade list <module-id> - 列出模块可用回滚点
 * - finger upgrade rollback <module-id> - 回滚到最新回滚点
 * - finger upgrade status - 显示升级状态
 */

import { Command } from 'commander';
import * as readline from 'node:readline/promises';
import { stdin as stdinInput, stdout as stdoutOutput } from 'node:process';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { moduleLayers } from '../orchestration/module-layers.js';
import type { ModuleTier, UpgradePolicyType } from '../orchestration/module-layers.js';
import { UpgradeEngine } from '../orchestration/upgrade-engine.js';
import type { UpgradeConfig, HotUpgradeConfig, FullUpgradeConfig, UpgradeResult } from '../orchestration/upgrade-engine.js';
import { RollbackManager } from '../orchestration/rollback-manager.js';
import type { RollbackPoint } from '../orchestration/rollback-manager.js';
import { OrchestrationDaemon } from '../orchestration/daemon.js';
import { resolve } from 'path';
import { homedir } from 'os';

const clog = createConsoleLikeLogger('UpgradeCLI');

interface UpgradeOptions {
  version?: string;
  all?: boolean;
  core?: boolean;
  list?: string;
  rollback?: string;
  source?: string;
  target?: string;
  yes?: boolean;
}

/**
 * 注册 upgrade 命令
 */
export function registerUpgradeCommand(program: Command): void {
  const upgrade = program
    .command('upgrade')
    .description('模块升级管理（支持热升级与完整升级）');

  upgrade
    .command('run <moduleId>')
    .description('升级指定模块')
    .option('-v, --version <version>', '目标版本号')
    .option('-s, --source <path>', '源代码路径')
    .option('-t, --target <path>', '目标安装路径')
    .option('-y, --yes', '跳过确认提示')
    .action(async (moduleId: string, options: UpgradeOptions) => {
      await runUpgrade(moduleId, options);
    });

  upgrade
    .command('all')
    .description('升级所有 Extension 模块')
    .option('-y, --yes', '跳过确认提示')
    .action(async (options: UpgradeOptions) => {
      await upgradeAllExtensions(options);
    });

  upgrade
    .command('core')
    .description('升级 Core 层（需要 daemon 重启）')
    .option('-y, --yes', '跳过确认提示')
    .option('-s, --source <path>', '源 dist 目录')
    .action(async (options: UpgradeOptions) => {
      await upgradeCore(options);
    });

  upgrade
    .command('list <moduleId>')
    .description('列出模块可用回滚点')
    .action(async (moduleId: string) => {
      await listRollbackPoints(moduleId);
    });

  upgrade
    .command('rollback <moduleId>')
    .description('回滚模块到最新回滚点')
    .option('-y, --yes', '跳过确认提示')
    .action(async (moduleId: string, options: UpgradeOptions) => {
      await rollbackModule(moduleId, options);
    });

  upgrade
    .command('status')
    .description('显示模块升级状态概览')
    .action(async () => {
      await showUpgradeStatus();
    });
}

async function runUpgrade(moduleId: string, options: UpgradeOptions): Promise<void> {
  clog.log(`Starting upgrade for module: ${moduleId}`);

  try {
    await moduleLayers.load();

    const tier = moduleLayers.getModuleTier(moduleId);
    const policy = moduleLayers.getUpgradePolicy(moduleId);

    if (tier === 'unknown') {
      clog.error(`Unknown module: ${moduleId}`);
      clog.log('Use "finger upgrade status" to see available modules.');
      process.exit(1);
    }

    clog.log(`Module tier: ${tier}, upgrade policy: ${policy.type}`);

    if (tier === 'core' && !options.yes) {
      const confirmed = await confirmAction(
        'Core module upgrade requires daemon restart. Continue? (y/N)',
      );
      if (!confirmed) {
        clog.log('Upgrade cancelled.');
        process.exit(0);
      }
    }

    const targetVersion = options.version || generateTimestampVersion();
    const engine = new UpgradeEngine();

    let config: UpgradeConfig;

    if (tier === 'extension') {
      config = buildHotUpgradeConfig(moduleId, targetVersion, options);
    } else {
      config = buildFullUpgradeConfig(moduleId, options);
    }

    const result = await engine.executeUpgrade(moduleId, targetVersion, config);

    displayUpgradeResult(result);

    if (result.ok) {
      clog.log(`✓ Module ${moduleId} upgraded to ${targetVersion}`);

      if (tier === 'core') {
        clog.log('Restarting daemon...');
        await restartDaemon();
      }
    } else {
      clog.error(`✗ Upgrade failed: ${result.error}`);
      if (result.rolledBack) {
        clog.log('  (Changes have been rolled back)');
      }
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`Upgrade error: ${message}`);
    process.exit(1);
  }
}

async function upgradeAllExtensions(options: UpgradeOptions): Promise<void> {
  clog.log('Upgrading all Extension modules...');

  try {
    await moduleLayers.load();

    const cfg = moduleLayers.getConfig();
    const extensionModules = cfg.layers.extension.modules;

    if (!options.yes) {
      const confirmed = await confirmAction(
        `This will upgrade ${extensionModules.length} extension modules. Continue? (y/N)`,
      );
      if (!confirmed) {
        clog.log('Upgrade cancelled.');
        process.exit(0);
      }
    }

    const results: { moduleId: string; ok: boolean; error?: string }[] = [];
    const engine = new UpgradeEngine();

    for (const moduleId of extensionModules) {
      if (moduleId.includes('*')) {
        clog.log(`Skipping wildcard pattern: ${moduleId}`);
        continue;
      }

      clog.log(`Upgrading ${moduleId}...`);

      try {
        const targetVersion = generateTimestampVersion();
        const hotConfig = buildHotUpgradeConfig(moduleId, targetVersion, {});
        const result = await engine.executeUpgrade(moduleId, targetVersion, hotConfig);

        results.push({ moduleId, ok: result.ok, error: result.error });

        if (result.ok) {
          clog.log(`  ✓ ${moduleId} upgraded`);
        } else {
          clog.error(`  ✗ ${moduleId} failed: ${result.error}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ moduleId, ok: false, error: message });
        clog.error(`  ✗ ${moduleId} error: ${message}`);
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;

    clog.log(`\nUpgrade complete: ${succeeded} succeeded, ${failed} failed`);

    if (failed > 0) {
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`Upgrade all error: ${message}`);
    process.exit(1);
  }
}

async function upgradeCore(options: UpgradeOptions): Promise<void> {
  clog.log('Upgrading Core layer...');

  try {
    await moduleLayers.load();

    if (!options.yes) {
      clog.log('⚠️  WARNING: Core layer upgrade requires:');
      clog.log('   1. Stop all running daemons');
      clog.log('   2. Replace core files');
      clog.log('   3. Restart daemons');
      clog.log('');

      const confirmed = await confirmAction(
        'This is a disruptive operation. Continue? (y/N)',
      );
      if (!confirmed) {
        clog.log('Upgrade cancelled.');
        process.exit(0);
      }
    }

    clog.log('Stopping daemon...');
    await stopDaemon();

    const engine = new UpgradeEngine();
    const fullConfig = buildFullUpgradeConfig('core', options);
    const result = await engine.executeUpgrade('core', generateTimestampVersion(), fullConfig);

    if (result.ok) {
      clog.log('✓ Core layer upgraded');

      clog.log('Restarting daemon...');
      await restartDaemon();

      clog.log('✓ Core upgrade complete');
    } else {
      clog.error(`✗ Core upgrade failed: ${result.error}`);
      if (result.rolledBack) {
        clog.log('  (Changes have been rolled back)');
      }
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`Core upgrade error: ${message}`);
    process.exit(1);
  }
}

async function listRollbackPoints(moduleId: string): Promise<void> {
  try {
    await moduleLayers.load();

    const rollbackManager = new RollbackManager();
    const points = rollbackManager.listRollbackPoints(moduleId);

    if (points.length === 0) {
      clog.log(`No rollback points found for module: ${moduleId}`);
      return;
    }

    clog.log(`Rollback points for ${moduleId}:`);
    clog.log('');

    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const createdAt = new Date(point.createdAt).toLocaleString();
      clog.log(`  ${i + 1}. Version: ${point.version}`);
      clog.log(`     Created: ${createdAt}`);
      clog.log(`     Files: ${point.snapshotFiles.length}`);
      clog.log(`     Path: ${point.backupPath}`);
      clog.log('');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`List rollback points error: ${message}`);
    process.exit(1);
  }
}

async function rollbackModule(moduleId: string, options: UpgradeOptions): Promise<void> {
  clog.log(`Rolling back module: ${moduleId}`);

  try {
    await moduleLayers.load();

    const rollbackManager = new RollbackManager();
    const point = rollbackManager.getLatestRollbackPoint(moduleId);

    if (!point) {
      clog.error(`No rollback points available for module: ${moduleId}`);
      process.exit(1);
    }

    const createdAt = new Date(point.createdAt).toLocaleString();
    clog.log('Latest rollback point:');
    clog.log(`  Version: ${point.version}`);
    clog.log(`  Created: ${createdAt}`);

    if (!options.yes) {
      const confirmed = await confirmAction('Proceed with rollback? (y/N)');
      if (!confirmed) {
        clog.log('Rollback cancelled.');
        process.exit(0);
      }
    }

    const targetDir = resolve(homedir(), '.finger', 'modules', moduleId);
    const result = await rollbackManager.executeRollback(point, targetDir);

    if (result.ok) {
      clog.log(`✓ Module ${moduleId} rolled back to ${point.version}`);
    } else {
      clog.error(`✗ Rollback failed: ${result.error}`);
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`Rollback error: ${message}`);
    process.exit(1);
  }
}

async function showUpgradeStatus(): Promise<void> {
  try {
    await moduleLayers.load();

    const cfg = moduleLayers.getConfig();
    const rollbackManager = new RollbackManager();

    clog.log('=== Module Upgrade Status ===');
    clog.log('');

    clog.log('[Core Layer]');
    clog.log(`  Upgrade Policy: ${cfg.layers.core.upgradePolicy}`);
    clog.log(`  Requires Restart: ${cfg.layers.core.requiresRestart}`);
    clog.log('  Modules:');
    for (const mod of cfg.layers.core.modules) {
      const points = rollbackManager.listRollbackPoints(mod);
      clog.log(`    - ${mod} (${points.length} rollback points)`);
    }
    clog.log('');

    clog.log('[Extension Layer]');
    clog.log(`  Upgrade Policy: ${cfg.layers.extension.upgradePolicy}`);
    clog.log(`  Requires Restart: ${cfg.layers.extension.requiresRestart}`);
    clog.log(`  Isolation: ${cfg.layers.extension.isolation || 'none'}`);
    clog.log('  Modules:');
    for (const mod of cfg.layers.extension.modules) {
      if (!mod.includes('*')) {
        const points = rollbackManager.listRollbackPoints(mod);
        clog.log(`    - ${mod} (${points.length} rollback points)`);
      } else {
        clog.log(`    - ${mod} (pattern)`);
      }
    }
    clog.log('');

    clog.log('[Rollback Config]');
    clog.log(`  Max Points: ${cfg.rollback.maxPoints}`);
    clog.log(`  Storage: ${cfg.rollback.storagePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clog.error(`Status error: ${message}`);
    process.exit(1);
  }
}

// ============ Helper Functions ============

function buildHotUpgradeConfig(
  moduleId: string,
  version: string,
  options: UpgradeOptions,
): HotUpgradeConfig {
  return {
    moduleId,
    version,
    sourcePath: options.source || resolve(homedir(), '.finger', 'dist', 'modules', moduleId),
    healthCheck: async () => true,
  };
}

function buildFullUpgradeConfig(_moduleId: string, options: UpgradeOptions): FullUpgradeConfig {
  return {
    sourceDistDir: options.source || resolve(process.cwd(), 'dist'),
    targetDistDir: resolve(homedir(), '.finger', 'dist'),
    requiresRestart: true,
  };
}

function generateTimestampVersion(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function confirmAction(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: stdinInput,
    output: stdoutOutput,
  });

  try {
    const answer = await rl.question(prompt + ' ');
    return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function restartDaemon(): Promise<void> {
  try {
    const daemon = new OrchestrationDaemon();
    await daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await daemon.start();
  } catch {
    clog.log('  (Daemon restart skipped - not running or already stopped)');
  }
}

async function stopDaemon(): Promise<void> {
  try {
    const daemon = new OrchestrationDaemon();
    await daemon.stop();
  } catch {
    // Best effort
  }
}

function displayUpgradeResult(result: UpgradeResult): void {
  clog.log('\nUpgrade Steps:');
  for (const step of result.steps) {
    const icon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : '→';
    const duration = step.startedAt && step.completedAt
      ? ` (${new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()}ms)`
      : '';
    clog.log(`  ${icon} ${step.action}${duration}`);
    if (step.error) {
      clog.log(`     Error: ${step.error}`);
    }
  }
  clog.log('');
}
