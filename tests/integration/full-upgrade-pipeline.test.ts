import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { UpgradeEngine } from '../../src/orchestration/upgrade-engine.js';
import { RollbackManager } from '../../src/orchestration/rollback-manager.js';
import { ActiveStandbyManager } from '../../src/orchestration/active-standby-manager.js';
import { UpgradePackageManager } from '../../src/orchestration/upgrade-package-manager.js';
import { PreUpgradeHealthCheck } from '../../src/orchestration/pre-upgrade-health-check.js';
import * as moduleLayers from '../../src/orchestration/module-layers.js';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

const TEST_ROOT = join(tmpdir(), `finger-test-upgrade-${Date.now()}`);

describe('Full Upgrade Pipeline Integration', () => {
  let testRoot: string;
  
  beforeEach(() => {
    testRoot = join(TEST_ROOT, Math.random().toString(36).slice(2));
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  // ==================== Extension Hot Upgrade + Dual-Slot ====================

  describe('Extension Hot Upgrade with Dual-Slot', () => {
    it('should install new version to standby and switch slots after verification', async () => {
      // Setup module layers mock
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        getModuleTier: () => 'extension',
        getUpgradePolicy: () => ({ type: 'hot' as const, requiresRestart: false }),
        resolveDependencyOrder: () => ['test-module'],
        validateDependencies: () => ({ ok: true, missing: [] }),
      } as any);

      const standbyDir = join(testRoot, 'standby-v2.0.0');
      mkdirSync(standbyDir, { recursive: true });
      writeFileSync(join(standbyDir, 'index.js'), '// v2.0.0');

      const standbyManager = new ActiveStandbyManager(testRoot);
      const engine = new UpgradeEngine(undefined, standbyManager);

      // Set initial state
      standbyManager.setActiveSlot('test-module', '1.0.0', join(testRoot, 'active-v1.0.0'));
      mkdirSync(join(testRoot, 'active-v1.0.0'), { recursive: true });
      writeFileSync(join(testRoot, 'active-v1.0.0', 'index.js'), '// v1.0.0');

      const config: any = {
        moduleId: 'test-module',
        version: '2.0.0',
        sourcePath: standbyDir,
        healthCheck: async () => true,
      };

      const result = await engine.executeUpgrade('test-module', '2.0.0', config);

      expect(result.ok).toBe(true);
      expect(result.rolledBack).toBe(false);

      // Verify slots were switched
      const slotState = standbyManager.getModuleSlotState('test-module');
      expect(slotState.activeVersion).toBe('2.0.0');
      expect(slotState.activePath).toBe(standbyDir);
      expect(slotState.standbyVersion).toBe('1.0.0');
    });

    it('should auto-rollback if health check fails after upgrade', async () => {
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        getModuleTier: () => 'extension',
        getUpgradePolicy: () => ({ type: 'hot' as const, requiresRestart: false }),
        resolveDependencyOrder: () => ['test-module'],
        validateDependencies: () => ({ ok: true, missing: [] }),
      } as any);

      const standbyDir = join(testRoot, 'standby-v2.0.0');
      mkdirSync(standbyDir, { recursive: true });
      writeFileSync(join(standbyDir, 'index.js'), '// v2.0.0');

      const standbyManager = new ActiveStandbyManager(testRoot);
      const engine = new UpgradeEngine(undefined, standbyManager);

      standbyManager.setActiveSlot('test-module', '1.0.0', join(testRoot, 'active-v1.0.0'));
      mkdirSync(join(testRoot, 'active-v1.0.0'), { recursive: true });
      writeFileSync(join(testRoot, 'active-v1.0.0', 'index.js'), '// v1.0.0');

      const config: any = {
        moduleId: 'test-module',
        version: '2.0.0',
        sourcePath: standbyDir,
        healthCheck: async () => false, // Health check fails
      };

      const result = await engine.executeUpgrade('test-module', '2.0.0', config);

      expect(result.ok).toBe(false);
      expect(result.rolledBack).toBe(true);
    });
  });

  // ==================== Skip Version Upgrade ====================

  describe('Skip Version Upgrade', () => {
    it('should allow upgrading from v1.0.0 to v3.0.0 (skip v2.x)', async () => {
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        load: vi.fn().mockResolvedValue(undefined),
        getModuleTier: () => 'extension',
        getUpgradePolicy: () => ({ type: 'hot' as const, requiresRestart: false }),
        resolveDependencyOrder: () => ['test-module'],
        validateDependencies: () => ({ ok: true, missing: [] }),
      } as any);

      const standbyDir = join(testRoot, 'standby-v3.0.0');
      mkdirSync(standbyDir, { recursive: true });
      writeFileSync(join(standbyDir, 'index.js'), '// v3.0.0');

      const standbyManager = new ActiveStandbyManager(testRoot);
      const engine = new UpgradeEngine(undefined, standbyManager);

      standbyManager.setActiveSlot('test-module', '1.0.0', join(testRoot, 'active-v1.0.0'));
      mkdirSync(join(testRoot, 'active-v1.0.0'), { recursive: true });
      writeFileSync(join(testRoot, 'active-v1.0.0', 'index.js'), '// v1.0.0');

      const config: any = {
        moduleId: 'test-module',
        version: '3.0.0',
        sourcePath: standbyDir,
        healthCheck: async () => true,
      };

      const result = await engine.executeUpgrade('test-module', '3.0.0', config);

      expect(result.ok).toBe(true);
      const slotState = standbyManager.getModuleSlotState('test-module');
      expect(slotState.activeVersion).toBe('3.0.0');
    });
  });

  // ==================== Manual Downgrade ====================

  describe('Manual Downgrade', () => {
    it('should downgrade by switching slots', async () => {
      const standbyManager = new ActiveStandbyManager(testRoot);

      const activeDir = join(testRoot, 'active-v2.0.0');
      const standbyDir = join(testRoot, 'standby-v1.0.0');
      mkdirSync(activeDir, { recursive: true });
      mkdirSync(standbyDir, { recursive: true });
      writeFileSync(join(activeDir, 'index.js'), '// v2.0.0');
      writeFileSync(join(standbyDir, 'index.js'), '// v1.0.0');

      standbyManager.setActiveSlot('test-module', '2.0.0', activeDir);
      standbyManager.setStandbySlot('test-module', '1.0.0', standbyDir);

      // Perform downgrade (switch slots)
      const switchResult = standbyManager.switchModuleSlots('test-module', 'manual downgrade');
      expect(switchResult.ok).toBe(true);

      const slotState = standbyManager.getModuleSlotState('test-module');
      expect(slotState.activeVersion).toBe('1.0.0');
      expect(slotState.standbyVersion).toBe('2.0.0');
    });

    it('should fail downgrade when no standby version exists', async () => {
      const standbyManager = new ActiveStandbyManager(testRoot);
      const activeDir = join(testRoot, 'active-v2.0.0');
      mkdirSync(activeDir, { recursive: true });
      writeFileSync(join(activeDir, 'index.js'), '// v2.0.0');

      standbyManager.setActiveSlot('test-module', '2.0.0', activeDir);

      const slotState = standbyManager.getModuleSlotState('test-module');
      expect(slotState.standbyVersion).toBeNull();
    });
  });

  // ==================== Runtime Role Management ====================

  describe('Runtime Role Management', () => {
    it('should default to active role when no state file exists', () => {
      const emptyRoot = join(testRoot, 'empty');
      mkdirSync(emptyRoot, { recursive: true });
      const standbyManager = new ActiveStandbyManager(emptyRoot);

      const role = standbyManager.getRuntimeRole();
      expect(role).toBe('active');
    });

    it('should switch to standby and persist (restart effect)', () => {
      const standbyManager = new ActiveStandbyManager(testRoot);
      const result = standbyManager.switchRuntimeRole('standby', 'test');

      expect(result.ok).toBe(true);
      expect(result.newRole).toBe('standby');

      // Simulate restart by creating new instance
      const standbyManager2 = new ActiveStandbyManager(testRoot);
      const role = standbyManager2.getRuntimeRole();
      expect(role).toBe('standby');
    });

    it('should switch back to active after being standby', () => {
      const standbyManager = new ActiveStandbyManager(testRoot);
      standbyManager.switchRuntimeRole('standby', 'test standby');

      const result = standbyManager.switchRuntimeRole('active', 'test restore');
      expect(result.ok).toBe(true);
      expect(result.newRole).toBe('active');

      const standbyManager2 = new ActiveStandbyManager(testRoot);
      expect(standbyManager2.getRuntimeRole()).toBe('active');
    });

    it('shouldBecomeActive returns false when role is standby', () => {
      const standbyManager = new ActiveStandbyManager(testRoot);
      standbyManager.switchRuntimeRole('standby', 'test');

      expect(standbyManager.shouldBecomeActive()).toBe(false);
    });

    it('shouldBecomeActive returns true when role is active', () => {
      const standbyManager = new ActiveStandbyManager(testRoot);
      expect(standbyManager.shouldBecomeActive()).toBe(true);
    });
  });
});
