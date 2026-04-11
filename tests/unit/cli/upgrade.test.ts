import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// Hoisted mocks
const moduleLayersMocks = vi.hoisted(() => ({
  load: vi.fn(),
  getModuleTier: vi.fn(),
  getUpgradePolicy: vi.fn(),
  getDependencies: vi.fn(),
  validateDependencies: vi.fn(),
  resolveDependencyOrder: vi.fn(),
  getConfig: vi.fn(),
}));

const upgradeEngineMocks = vi.hoisted(() => ({
  planUpgrade: vi.fn(),
  executeUpgrade: vi.fn(),
  rollback: vi.fn(),
}));

const rollbackManagerMocks = vi.hoisted(() => ({
  listRollbackPoints: vi.fn(),
  getLatestRollbackPoint: vi.fn(),
  executeRollback: vi.fn(),
}));

const daemonMocks = vi.hoisted(() => ({
  restart: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  isRunning: vi.fn(),
}));

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

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('../../../src/core/logger/console-like.js', () => ({
  createConsoleLikeLogger: vi.fn(() => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

// Import after mocks
import { registerUpgradeCommand } from '../../../src/cli/upgrade.js';

describe('Upgrade CLI', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    registerUpgradeCommand(program);
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('upgrade run <moduleId>', () => {
    it('should upgrade extension module with hot policy', async () => {
      moduleLayersMocks.load.mockResolvedValue({});
      moduleLayersMocks.getModuleTier.mockReturnValue('extension');
      moduleLayersMocks.getUpgradePolicy.mockReturnValue({ type: 'hot', requiresRestart: false });
      moduleLayersMocks.validateDependencies.mockReturnValue({ ok: true, missing: [] });
      moduleLayersMocks.resolveDependencyOrder.mockReturnValue(['test-module']);
      
      upgradeEngineMocks.planUpgrade.mockResolvedValue({
        moduleId: 'test-module',
        targetVersion: '2024-01-01-001',
        upgradeType: 'hot',
        requiresRestart: false,
        dependencyOrder: ['test-module'],
      });
      
      upgradeEngineMocks.executeUpgrade.mockResolvedValue({
        ok: true,
        moduleId: 'test-module',
        version: '2024-01-01-001',
        status: 'success',
      });

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'test-module', '--yes']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
      expect(moduleLayersMocks.getModuleTier).toHaveBeenCalledWith('test-module');
      expect(upgradeEngineMocks.executeUpgrade).toHaveBeenCalled();
    });

    it('should exit with error for unknown module', async () => {
      moduleLayersMocks.load.mockResolvedValue({});
      moduleLayersMocks.getModuleTier.mockReturnValue('unknown');

      await program.parseAsync(['node', 'test', 'upgrade', 'run', 'unknown-module', '--yes']);

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('upgrade all', () => {
    it('should upgrade all extension modules', async () => {
      moduleLayersMocks.load.mockResolvedValue({});
      moduleLayersMocks.getModuleTier.mockReturnValue('extension');
      moduleLayersMocks.getUpgradePolicy.mockReturnValue({ type: 'hot', requiresRestart: false });
      moduleLayersMocks.validateDependencies.mockReturnValue({ ok: true, missing: [] });
      moduleLayersMocks.resolveDependencyOrder.mockReturnValue(['module-a']);
      
      upgradeEngineMocks.planUpgrade.mockResolvedValue({
        moduleId: 'test',
        targetVersion: '2024-01-01-001',
        upgradeType: 'hot',
        requiresRestart: false,
        dependencyOrder: ['test'],
      });
      
      upgradeEngineMocks.executeUpgrade.mockResolvedValue({
        ok: true,
        moduleId: 'test',
        version: '2024-01-01-001',
        status: 'success',
      });

      const mockConfig = {
        layers: {
          extension: {
            modules: ['finger-executor-agent'],
          },
        },
      };
      moduleLayersMocks.getConfig.mockReturnValue(mockConfig);

      await program.parseAsync(['node', 'test', 'upgrade', 'all', '--yes']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
    });
  });

  describe('upgrade core', () => {
    it('should upgrade core layer', async () => {
      moduleLayersMocks.load.mockResolvedValue({});
      daemonMocks.isRunning.mockReturnValue(false);

      await program.parseAsync(['node', 'test', 'upgrade', 'core', '--yes']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
    });
  });

  describe('upgrade list <moduleId>', () => {
    it('should list rollback points for module', async () => {
      const mockPoints = [
        { id: 'rp-1', moduleId: 'test-module', version: '1.0.0', createdAt: Date.now() },
        { id: 'rp-2', moduleId: 'test-module', version: '0.9.0', createdAt: Date.now() - 1000 },
      ];
      rollbackManagerMocks.listRollbackPoints.mockReturnValue(mockPoints);

      await program.parseAsync(['node', 'test', 'upgrade', 'list', 'test-module']);

      expect(rollbackManagerMocks.listRollbackPoints).toHaveBeenCalledWith('test-module');
    });

    it('should handle empty rollback points', async () => {
      rollbackManagerMocks.listRollbackPoints.mockReturnValue([]);

      await program.parseAsync(['node', 'test', 'upgrade', 'list', 'test-module']);

      expect(rollbackManagerMocks.listRollbackPoints).toHaveBeenCalledWith('test-module');
    });
  });

  describe('upgrade rollback <moduleId>', () => {
    it('should rollback to latest rollback point with --yes', async () => {
      const mockPoint = {
        id: 'rp-1',
        moduleId: 'test-module',
        version: '1.0.0',
        createdAt: Date.now(),
        backupPath: '/tmp/backup/test-module/1.0.0',
        tier: 'extension',
        files: ['/tmp/a.js'],
      };
      rollbackManagerMocks.getLatestRollbackPoint.mockReturnValue(mockPoint);
      rollbackManagerMocks.executeRollback.mockResolvedValue({ ok: true });

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(rollbackManagerMocks.getLatestRollbackPoint).toHaveBeenCalledWith('test-module');
    });

    it('should exit with error when no rollback point available', async () => {
      rollbackManagerMocks.getLatestRollbackPoint.mockReturnValue(undefined);

      await program.parseAsync(['node', 'test', 'upgrade', 'rollback', 'test-module', '--yes']);

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('upgrade status', () => {
    it('should display module upgrade status overview', async () => {
      moduleLayersMocks.load.mockResolvedValue({});
      
      const mockConfig = {
        layers: {
          core: { modules: ['runtime-facade'], upgradePolicy: 'full', requiresRestart: true },
          extension: { modules: ['finger-executor-agent'], upgradePolicy: 'hot', requiresRestart: false, isolation: 'worker' },
        },
        rollback: { maxPoints: 3, storagePath: '~/.finger/rollback' },
      };
      moduleLayersMocks.getConfig.mockReturnValue(mockConfig);
      
      rollbackManagerMocks.listRollbackPoints.mockReturnValue([]);

      await program.parseAsync(['node', 'test', 'upgrade', 'status']);

      expect(moduleLayersMocks.load).toHaveBeenCalled();
    });
  });
});
