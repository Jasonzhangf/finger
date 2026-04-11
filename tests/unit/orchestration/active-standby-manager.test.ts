import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ActiveStandbyManager } from '../../../src/orchestration/active-standby-manager.js';
import type { RuntimeRoleState, ModuleSlotState } from '../../../src/orchestration/active-standby-manager.js';

// Mock fs operations
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

describe('ActiveStandbyManager', () => {
  let manager: ActiveStandbyManager;
  let mockFs: typeof fs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs = vi.mocked(fs);
    manager = new ActiveStandbyManager('/tmp/test-runtime');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== Runtime 主备管理测试 ====================

  describe('Runtime Role Management', () => {
    describe('getRuntimeRole()', () => {
      it('should return "active" when no state file exists', () => {
        mockFs.existsSync.mockReturnValue(false);
        expect(manager.getRuntimeRole()).toBe('active');
      });

      it('should return "standby" when state file has standby role', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          role: 'standby',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: 'active',
          switchReason: 'manual standby',
        }));
        expect(manager.getRuntimeRole()).toBe('standby');
      });

      it('should return "active" when state file has active role', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          role: 'active',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: 'standby',
          switchReason: 'manual active',
        }));
        expect(manager.getRuntimeRole()).toBe('active');
      });

      it('should return "active" on read error', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockImplementation(() => {
          throw new Error('Read error');
        });
        expect(manager.getRuntimeRole()).toBe('active');
      });
    });

    describe('getRuntimeRoleState()', () => {
      it('should return null when no state file exists', () => {
        mockFs.existsSync.mockReturnValue(false);
        expect(manager.getRuntimeRoleState()).toBeNull();
      });

      it('should return state object when file exists', () => {
        const state: RuntimeRoleState = {
          role: 'standby',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: 'active',
          switchReason: 'manual standby',
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(state));
        expect(manager.getRuntimeRoleState()).toEqual(state);
      });

      it('should return null on read error', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockImplementation(() => {
          throw new Error('Read error');
        });
        expect(manager.getRuntimeRoleState()).toBeNull();
      });
    });

    describe('switchRuntimeRole()', () => {
      it('should switch from active to standby', () => {
        mockFs.existsSync.mockReturnValue(false);
        const result = manager.switchRuntimeRole('standby', 'manual standby');

        expect(result.ok).toBe(true);
        expect(result.previousRole).toBe('active');
        expect(result.newRole).toBe('standby');
        expect(result.reason).toBe('manual standby');

        expect(mockFs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.role).toBe('standby');
        expect(writtenData.previousRole).toBe('active');
      });

      it('should switch from standby to active', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          role: 'standby',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: 'active',
          switchReason: 'manual standby',
        }));

        const result = manager.switchRuntimeRole('active', 'manual active');

        expect(result.ok).toBe(true);
        expect(result.previousRole).toBe('standby');
        expect(result.newRole).toBe('active');
      });
    });

    describe('shouldBecomeActive()', () => {
      it('should return true when role is active', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          role: 'active',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: null,
          switchReason: 'startup',
        }));
        expect(manager.shouldBecomeActive()).toBe(true);
      });

      it('should return false when role is standby', () => {
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify({
          role: 'standby',
          switchedAt: '2026-04-11T00:00:00Z',
          previousRole: 'active',
          switchReason: 'manual standby',
        }));
        expect(manager.shouldBecomeActive()).toBe(false);
      });

      it('should return true when no state file exists (default active)', () => {
        mockFs.existsSync.mockReturnValue(false);
        expect(manager.shouldBecomeActive()).toBe(true);
      });
    });
  });

  // ==================== 模块双槽位管理测试 ====================

  describe('Module Slot Management', () => {
    describe('getModuleSlotState()', () => {
      it('should return empty state when no state file exists', () => {
        mockFs.existsSync.mockReturnValue(false);
        const state = manager.getModuleSlotState('test-module');

        expect(state.moduleId).toBe('test-module');
        expect(state.activeVersion).toBeNull();
        expect(state.standbyVersion).toBeNull();
      });

      it('should return state when file exists', () => {
        const state: ModuleSlotState = {
          moduleId: 'test-module',
          activeVersion: '1.0.0',
          activePath: '/tmp/active',
          standbyVersion: '1.1.0',
          standbyPath: '/tmp/standby',
          lastSwitchAt: '2026-04-11T00:00:00Z',
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(state));

        const result = manager.getModuleSlotState('test-module');
        expect(result).toEqual(state);
      });
    });

    describe('setActiveSlot()', () => {
      it('should set active slot and save state', () => {
        mockFs.existsSync.mockReturnValue(false);
        manager.setActiveSlot('test-module', '1.0.0', '/tmp/active');

        expect(mockFs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.activeVersion).toBe('1.0.0');
        expect(writtenData.activePath).toBe('/tmp/active');
      });
    });

    describe('setStandbySlot()', () => {
      it('should set standby slot and save state', () => {
        mockFs.existsSync.mockReturnValue(false);
        manager.setStandbySlot('test-module', '1.1.0', '/tmp/standby');

        expect(mockFs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.standbyVersion).toBe('1.1.0');
        expect(writtenData.standbyPath).toBe('/tmp/standby');
      });
    });

    describe('switchModuleSlots()', () => {
      it('should fail when no standby slot available', () => {
        mockFs.existsSync.mockReturnValue(false);
        const result = manager.switchModuleSlots('test-module', 'upgrade');

        expect(result.ok).toBe(false);
      });

      it('should switch slots successfully', () => {
        const initialState: ModuleSlotState = {
          moduleId: 'test-module',
          activeVersion: '1.0.0',
          activePath: '/tmp/active-v1',
          standbyVersion: '1.1.0',
          standbyPath: '/tmp/standby-v1.1',
          lastSwitchAt: '2026-04-11T00:00:00Z',
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(initialState));

        const result = manager.switchModuleSlots('test-module', 'upgrade');

        expect(result.ok).toBe(true);
        expect(result.previousActive).toEqual({ version: '1.0.0', path: '/tmp/active-v1' });
        expect(result.newActive.version).toBe('1.1.0');

        // After switch: active becomes standby, standby becomes active
        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.activeVersion).toBe('1.1.0');
        expect(writtenData.standbyVersion).toBe('1.0.0');
      });

      it('should handle case with no previous active', () => {
        const initialState: ModuleSlotState = {
          moduleId: 'test-module',
          activeVersion: null,
          activePath: null,
          standbyVersion: '1.1.0',
          standbyPath: '/tmp/standby',
          lastSwitchAt: null,
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(initialState));

        const result = manager.switchModuleSlots('test-module', 'initial install');

        expect(result.ok).toBe(true);
        expect(result.previousActive).toBeNull();
        expect(result.newActive.version).toBe('1.1.0');

        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.activeVersion).toBe('1.1.0');
        expect(writtenData.standbyVersion).toBeNull();
      });
    });

    describe('downgradeModule()', () => {
      it('should call switchModuleSlots with manual downgrade reason', () => {
        const initialState: ModuleSlotState = {
          moduleId: 'test-module',
          activeVersion: '1.1.0',
          activePath: '/tmp/active-v1.1',
          standbyVersion: '1.0.0',
          standbyPath: '/tmp/standby-v1',
          lastSwitchAt: '2026-04-11T00:00:00Z',
        };
        mockFs.existsSync.mockReturnValue(true);
        mockFs.readFileSync.mockReturnValue(JSON.stringify(initialState));

        const result = manager.downgradeModule('test-module');

        expect(result.ok).toBe(true);
        expect(result.newActive.version).toBe('1.0.0'); // Downgraded to standby version
      });
    });

    describe('installToStandby()', () => {
      it('should install new version to standby slot', () => {
        mockFs.existsSync.mockReturnValue(false);
        manager.installToStandby('test-module', '2.0.0', '/tmp/new-version');

        expect(mockFs.writeFileSync).toHaveBeenCalled();
        const writtenData = JSON.parse(mockFs.writeFileSync.mock.calls[0][1] as string);
        expect(writtenData.standbyVersion).toBe('2.0.0');
        expect(writtenData.standbyPath).toBe('/tmp/new-version');
      });
    });

    describe('canUpgradeToTarget()', () => {
      it('should always allow upgrade (skip versions allowed)', () => {
        expect(manager.canUpgradeToTarget('1.0.0', '3.0.0')).toBe(true);
        expect(manager.canUpgradeToTarget('1.0.0', '1.1.0')).toBe(true);
        expect(manager.canUpgradeToTarget('2.5.0', '3.0.0')).toBe(true);
      });
    });

    describe('clearModuleSlotState()', () => {
      it('should delete state file when exists', () => {
        mockFs.existsSync.mockReturnValue(true);
        manager.clearModuleSlotState('test-module');
        expect(mockFs.rmSync).toHaveBeenCalled();
      });

      it('should not throw when file does not exist', () => {
        mockFs.existsSync.mockReturnValue(false);
        manager.clearModuleSlotState('test-module');
        expect(mockFs.rmSync).not.toHaveBeenCalled();
      });
    });
  });
});
