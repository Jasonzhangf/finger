/**
 * Unit tests for Upgrade CLI — tests/unit/cli/upgrade.test.ts
 *
 * Covers every subcommand with normal + error paths:
 *   upgrade run <module> — 3 tests
 *   upgrade all          — 2 tests
 *   upgrade core         — 2 tests
 *   upgrade list         — 2 tests
 *   upgrade rollback     — 2 tests
 *   upgrade status       — 1 test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

/* ========================================================
 * Hoisted mocks (before any import)
 * ======================================================== */

const moduleLayersMocks = vi.hoisted(() => ({
  load: vi.fn(),
  getModuleTier: vi.fn(),
  getUpgradePolicy: vi.fn(),
  getConfig: vi.fn(),
  getDependencies: vi.fn(),
  validateDependencies: vi.fn(),
  resolveDependencyOrder: vi.fn(),
}));

const upgradeEngineMocks = vi.hoisted(() => ({
  executeUpgrade: vi.fn(),
}));

const rollbackManagerMocks = vi.hoisted(() => ({
  listRollbackPoints: vi.fn(),
  getLatestRollbackPoint: vi.fn(),
  executeRollback: vi.fn(),
}));

const daemonMocks = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(),
}));

const mockQuestion = vi.fn();
const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: vi.fn(),
  })),
}));

const clogMock = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

/* ========================================================
 * Module mocks
 * ======================================================== */

vi.mock('../../../src/orchestration/module-layers.js', () => ({
  moduleLayers: moduleLayersMocks,
}));

vi.mock('../../../src/orchestration/upgrade-engine.js', () => ({
  UpgradeEngine: vi.fn(() => upgradeEngineMocks),
}));

vi.mock('../../../src/orchestration/rollback-manager.js', () => ({
  RollbackManager: vi.fn(() => rollbackManagerMocks),
}));

vi.mock('../../../src/orchestration/daemon.js', () => ({
  OrchestrationDaemon: vi.fn(() => daemonMocks),
}));

vi.mock('node:readline/promises', () => readlineMocks);

vi.mock('../../../src/core/logger/console-like.js', () => ({
  createConsoleLikeLogger: vi.fn(() => clogMock),
}));

/* ========================================================
 * Import SUT after mocks
 * ======================================================== */

import { registerUpgradeCommand } from '../../../src/cli/upgrade.js';

/* ========================================================
 * Test helpers
 * ======================================================== */

function baseMocks() {
  moduleLayersMocks.load.mockResolvedValue(undefined);
  moduleLayersMocks.getModuleTier.mockReturnValue('extension');
  moduleLayersMocks.getUpgradePolicy.mockReturnValue({ type: 'hot', requiresRestart: false });
}

function fakeUpgradeResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    moduleId: 'test-module',
    targetVersion: '2024-01-01T00-00-00',
    upgradeType: 'hot',
    steps: [],
    rolledBack: false,
    ...overrides,
  };
}

function answerRl(answer: string) {
  mockQuestion.mockResolvedValueOnce(answer);
}

/* ========================================================
 * Tests
 * ======================================================== */

describe('Upgrade CLI', () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    registerUpgradeCommand(program);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ── upgrade run <moduleId> ── */
  describe('upgrade run <moduleId>', () => {
    it('should upgrade extension module (hot) — normal', async () => {
      baseMocks();
      upgradeEngineMocks.executeUpgrade.mockResolvedValue(fakeUpgradeResult());

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'test-module', '--yes']);

      expect(upgradeEngineMocks.executeUpgrade).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error for unknown module', async () => {
      baseMocks();
      moduleLayersMocks.getModuleTier.mockReturnValue('unknown');

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'bad-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(expect.stringContaining('Unknown module'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit with error when upgrade result is not ok', async () => {
      baseMocks();
      upgradeEngineMocks.executeUpgrade.mockResolvedValue(
        fakeUpgradeResult({ ok: false, error: 'disk full' }),
      );

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'test-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Upgrade failed'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should catch unexpected errors and exit', async () => {
      moduleLayersMocks.load.mockRejectedValue(new Error('config broken'));

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'test-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Upgrade error'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── upgrade all ── */
  describe('upgrade all', () => {
    it('should upgrade all extension modules with --yes', async () => {
      baseMocks();
      moduleLayersMocks.getConfig.mockReturnValue({
        layers: {
          extension: { modules: ['ext-a', 'ext-b'] },
          core: { modules: ['core-a'] },
        },
        rollback: { maxPoints: 3, storagePath: '/tmp/rb' },
      });
      upgradeEngineMocks.executeUpgrade.mockResolvedValue(fakeUpgradeResult());

      await program.parseAsync(['node', 'test', 'upgrade', 'all', '--yes']);

      expect(upgradeEngineMocks.executeUpgrade).toHaveBeenCalledTimes(2);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error when some modules fail', async () => {
      baseMocks();
      moduleLayersMocks.getConfig.mockReturnValue({
        layers: {
          extension: { modules: ['ext-a', 'ext-b'] },
          core: { modules: [] },
        },
        rollback: { maxPoints: 3, storagePath: '/tmp/rb' },
      });
      upgradeEngineMocks.executeUpgrade
        .mockResolvedValueOnce(fakeUpgradeResult({ moduleId: 'ext-a' }))
        .mockResolvedValueOnce(fakeUpgradeResult({ moduleId: 'ext-b', ok: false, error: 'denied' }));

      await program.parseAsync(['node', 'test', 'upgrade', 'all', '--yes']);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit with error on unexpected error', async () => {
      moduleLayersMocks.load.mockRejectedValue(new Error('load fail'));

      await program.parseAsync(['node', 'test', 'upgrade', 'all', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(expect.stringContaining('Upgrade all error'));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── upgrade core ── */
  describe('upgrade core', () => {
    it('should upgrade core with --yes and restart daemon', async () => {
      daemonMocks.stop.mockResolvedValue(undefined);
      daemonMocks.start.mockResolvedValue(undefined);
      upgradeEngineMocks.executeUpgrade.mockResolvedValue(
        fakeUpgradeResult({ moduleId: 'core', upgradeType: 'full' }),
      );

      await program.parseAsync(['node', 'test', 'upgrade', 'core', '--yes']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
      expect(upgradeEngineMocks.executeUpgrade).toHaveBeenCalled();
      expect(daemonMocks.stop).toHaveBeenCalled();
      expect(daemonMocks.start).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error when core upgrade fails', async () => {
      daemonMocks.stop.mockResolvedValue(undefined);
      upgradeEngineMocks.executeUpgrade.mockResolvedValue(
        fakeUpgradeResult({ moduleId: 'core', ok: false, error: 'checksum' }),
      );

      await program.parseAsync(['node', 'test', 'upgrade', 'core', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Core upgrade failed'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── upgrade list <moduleId> ── */
  describe('upgrade list <moduleId>', () => {
    it('should list rollback points when available', async () => {
      rollbackManagerMocks.listRollbackPoints.mockReturnValue([
        {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension' as const,
          backupPath: '/tmp/rb',
          createdAt: '2024-01-01T00:00:00.000Z',
          snapshotFiles: ['index.js'],
        },
      ]);

      await program.parseAsync(['node', 'test', 'upgrade', 'list', 'test-module']);

      expect(rollbackManagerMocks.listRollbackPoints).toHaveBeenCalledWith('test-module');
      expect(clogMock.log).toHaveBeenCalledWith(
        expect.stringContaining('Rollback points'),
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should show "No rollback points found" when empty', async () => {
      rollbackManagerMocks.listRollbackPoints.mockReturnValue([]);

      await program.parseAsync(['node', 'test', 'upgrade', 'list', 'empty-module']);

      expect(clogMock.log).toHaveBeenCalledWith(
        expect.stringContaining('No rollback points found'),
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error on list failure', async () => {
      moduleLayersMocks.load.mockRejectedValue(new Error('cannot load'));

      await program.parseAsync(['node', 'test', 'upgrade', 'list', 'bad-module']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('List rollback points error'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── upgrade rollback <moduleId> ── */
  describe('upgrade rollback <moduleId>', () => {
    const fakePoint = {
      moduleId: 'test-module',
      version: '0.9.0',
      tier: 'extension' as const,
      backupPath: '/tmp/rb/old',
      createdAt: '2024-01-01T00:00:00.000Z',
      snapshotFiles: ['index.js'],
    };

    it('should rollback module with --yes', async () => {
      rollbackManagerMocks.getLatestRollbackPoint.mockReturnValue(fakePoint);
      rollbackManagerMocks.executeRollback.mockResolvedValue({ ok: true });

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(rollbackManagerMocks.getLatestRollbackPoint).toHaveBeenCalledWith('test-module');
      expect(rollbackManagerMocks.executeRollback).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error when no rollback points available', async () => {
      rollbackManagerMocks.getLatestRollbackPoint.mockReturnValue(null);

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('No rollback points available'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit with error when rollback execution fails', async () => {
      rollbackManagerMocks.getLatestRollbackPoint.mockReturnValue(fakePoint);
      rollbackManagerMocks.executeRollback.mockResolvedValue({ ok: false, error: 'missing file' });

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Rollback failed'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit with error on unexpected rollback error', async () => {
      moduleLayersMocks.load.mockRejectedValue(new Error('load fail'));

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Rollback error'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── upgrade status ── */
  describe('upgrade status', () => {
    it('should display module upgrade status overview', async () => {
      moduleLayersMocks.load.mockResolvedValue(undefined);
      moduleLayersMocks.getConfig.mockReturnValue({
        layers: {
          core: {
            upgradePolicy: 'full',
            requiresRestart: true,
            modules: ['core-a'],
          },
          extension: {
            upgradePolicy: 'hot',
            requiresRestart: false,
            isolation: 'vm',
            modules: ['ext-a', 'ext-*'],
          },
        },
        rollback: { maxPoints: 3, storagePath: '/tmp/rb' },
      });
      rollbackManagerMocks.listRollbackPoints.mockReturnValue([]);

      await program.parseAsync(['node', 'test', 'upgrade', 'status']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
      expect(clogMock.log).toHaveBeenCalledWith(
        expect.stringContaining('Module Upgrade Status'),
      );
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should exit with error when status retrieval fails', async () => {
      moduleLayersMocks.load.mockRejectedValue(new Error('disk read error'));

      await program.parseAsync(['node', 'test', 'upgrade', 'status']);

      expect(clogMock.error).toHaveBeenCalledWith(
        expect.stringContaining('Status error'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  /* ── command registration ── */
  describe('command registration', () => {
    it('should register upgrade command', () => {
      const cmd = program.commands.find((c) => c.name() === 'upgrade');
      expect(cmd).toBeDefined();
      expect(cmd!.description()).toContain('升级');
    });

    it('should have all expected subcommands', () => {
      const cmd = program.commands.find((c) => c.name() === 'upgrade')!;
      const names = cmd.commands.map((c) => c.name());
      for (const name of ['run', 'all', 'core', 'list', 'rollback', 'status']) {
        expect(names).toContain(name);
      }
    });
  });
});
