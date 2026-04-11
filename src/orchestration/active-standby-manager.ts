/**
 * Active-Standby Manager - 主备管理器
 *
 * 职责：
 * 1. 管理 Runtime 的主备状态（只有一个 runtime，本地可切主/切备）
 * 2. 管理模块的双槽位（active/standby）
 * 3. 主备切换（升级后倒换、手动降级）
 *
 * 规则：
 * - Runtime 重启后默认成为 ACTIVE
 * - 可手动切换到 STANDBY
 * - STANDBY 重启后保持 STANDBY（除非手动切回）
 * - 模块升级：新版本安装到 standby → 验证 → 切换 → 旧版本保留在 standby
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../core/logger.js';

const log = logger.module('ActiveStandbyManager');

export type RuntimeRole = 'active' | 'standby';
export type SlotRole = 'active' | 'standby';

export interface RuntimeRoleState {
  role: RuntimeRole;
  switchedAt: string;
  previousRole: RuntimeRole | null;
  switchReason: string;
}

export interface ModuleSlotState {
  moduleId: string;
  activeVersion: string | null;
  activePath: string | null;
  standbyVersion: string | null;
  standbyPath: string | null;
  lastSwitchAt: string | null;
}

export interface SwitchResult {
  ok: boolean;
  previousRole: RuntimeRole;
  newRole: RuntimeRole;
  reason: string;
  timestamp: string;
}

export interface ModuleSwitchResult {
  ok: boolean;
  moduleId: string;
  previousActive: { version: string; path: string } | null;
  newActive: { version: string; path: string };
  timestamp: string;
}

export class ActiveStandbyManager {
  private readonly runtimeRolePath: string;
  private readonly moduleSlotsPath: string;

  constructor(basePath?: string) {
    const root = basePath || resolve(homedir(), '.finger', 'runtime');
    this.runtimeRolePath = resolve(root, 'runtime-role.json');
    this.moduleSlotsPath = resolve(root, 'module-slots');
    mkdirSync(this.moduleSlotsPath, { recursive: true });
  }

  // ==================== Runtime 主备管理 ====================

  /**
   * 获取当前 Runtime 角色
   * 默认：重启后自动成为 ACTIVE
   */
  getRuntimeRole(): RuntimeRole {
    try {
      if (!existsSync(this.runtimeRolePath)) {
        return 'active'; // 默认 active
      }
      const state = JSON.parse(readFileSync(this.runtimeRolePath, 'utf-8')) as RuntimeRoleState;
      return state.role;
    } catch (error) {
      log.warn('Failed to read runtime role, defaulting to active', { error });
      return 'active';
    }
  }

  /**
   * 获取当前 Runtime 角色状态详情
   */
  getRuntimeRoleState(): RuntimeRoleState | null {
    try {
      if (!existsSync(this.runtimeRolePath)) {
        return null;
      }
      return JSON.parse(readFileSync(this.runtimeRolePath, 'utf-8')) as RuntimeRoleState;
    } catch (error) {
      log.warn('Failed to read runtime role state', { error });
      return null;
    }
  }

  /**
   * 切换 Runtime 角色
   * 切换后需要重启生效
   */
  switchRuntimeRole(newRole: RuntimeRole, reason: string): SwitchResult {
    const previousRole = this.getRuntimeRole();
    const timestamp = new Date().toISOString();

    const state: RuntimeRoleState = {
      role: newRole,
      switchedAt: timestamp,
      previousRole,
      switchReason: reason,
    };

    mkdirSync(resolve(this.runtimeRolePath, '..'), { recursive: true });
    writeFileSync(this.runtimeRolePath, JSON.stringify(state, null, 2), 'utf-8');

    log.info('Runtime role switched', { previousRole, newRole, reason });

    return {
      ok: true,
      previousRole,
      newRole,
      reason,
      timestamp,
    };
  }

  /**
   * 检查是否应该成为 ACTIVE
   * 规则：
   * - 首次启动（无状态文件）→ active
   * - 状态文件标记 active → active
   * - 状态文件标记 standby → standby（保持状态）
   */
  shouldBecomeActive(): boolean {
    return this.getRuntimeRole() === 'active';
  }

  // ==================== 模块双槽位管理 ====================

  /**
   * 获取模块槽位状态
   */
  getModuleSlotState(moduleId: string): ModuleSlotState {
    const statePath = resolve(this.moduleSlotsPath, `${moduleId}.json`);
    
    if (!existsSync(statePath)) {
      return {
        moduleId,
        activeVersion: null,
        activePath: null,
        standbyVersion: null,
        standbyPath: null,
        lastSwitchAt: null,
      };
    }

    try {
      return JSON.parse(readFileSync(statePath, 'utf-8')) as ModuleSlotState;
    } catch (error) {
      log.warn('Failed to read module slot state', { moduleId, error });
      return {
        moduleId,
        activeVersion: null,
        activePath: null,
        standbyVersion: null,
        standbyPath: null,
        lastSwitchAt: null,
      };
    }
  }

  /**
   * 设置模块 active 槽位
   */
  setActiveSlot(moduleId: string, version: string, path: string): void {
    const state = this.getModuleSlotState(moduleId);
    state.activeVersion = version;
    state.activePath = path;
    state.lastSwitchAt = new Date().toISOString();
    this.saveModuleSlotState(state);
  }

  /**
   * 设置模块 standby 槽位
   */
  setStandbySlot(moduleId: string, version: string, path: string): void {
    const state = this.getModuleSlotState(moduleId);
    state.standbyVersion = version;
    state.standbyPath = path;
    state.lastSwitchAt = new Date().toISOString();
    this.saveModuleSlotState(state);
  }

  /**
   * 模块主备切换（升级后倒换 / 降级）
   * 
   * 逻辑：
   * 1. 验证 standby 槽位有可用版本
   * 2. 交换 active 和 standby 槽位
   * 3. 保留旧版本在 standby（可用于再次降级）
   */
  switchModuleSlots(moduleId: string, reason: string): ModuleSwitchResult {
    const state = this.getModuleSlotState(moduleId);

    if (!state.standbyVersion || !state.standbyPath) {
      return {
        ok: false,
        moduleId,
        previousActive: null,
        newActive: { version: '', path: '' },
        timestamp: new Date().toISOString(),
      };
    }

    const previousActive = state.activeVersion
      ? { version: state.activeVersion, path: state.activePath || '' }
      : null;

    // 交换槽位
    const oldActiveVersion = state.activeVersion;
    const oldActivePath = state.activePath;
    
    state.activeVersion = state.standbyVersion;
    state.activePath = state.standbyPath;
    state.standbyVersion = oldActiveVersion || null;
    state.standbyPath = oldActivePath || null;
    state.lastSwitchAt = new Date().toISOString();

    this.saveModuleSlotState(state);

    log.info('Module slots switched', {
      moduleId,
      reason,
      newActive: state.activeVersion,
      newStandby: state.standbyVersion,
    });

    return {
      ok: true,
      moduleId,
      previousActive,
      newActive: {
        version: state.activeVersion!,
        path: state.activePath!,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 降级：将 standby 版本切回 active
   * 本质就是调用 switchModuleSlots
   */
  downgradeModule(moduleId: string): ModuleSwitchResult {
    return this.switchModuleSlots(moduleId, 'manual downgrade');
  }

  /**
   * 升级：安装新版本到 standby 槽位
   */
  installToStandby(moduleId: string, version: string, path: string): void {
    this.setStandbySlot(moduleId, version, path);
    log.info('New version installed to standby slot', { moduleId, version, path });
  }

  /**
   * 检查是否可以直接升级（跳过版本）
   * 允许：任何版本都可以直接升级到目标版本
   * 不限制：不需要逐步升级
   */
  canUpgradeToTarget(_currentVersion: string, _targetVersion: string): boolean {
    // 允许跳过版本，不限制升级路径
    return true;
  }

  // ==================== 内部方法 ====================

  private saveModuleSlotState(state: ModuleSlotState): void {
    const statePath = resolve(this.moduleSlotsPath, `${state.moduleId}.json`);
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * 清理模块槽位状态（删除模块时使用）
   */
  clearModuleSlotState(moduleId: string): void {
    const statePath = resolve(this.moduleSlotsPath, `${moduleId}.json`);
    if (existsSync(statePath)) {
      rmSync(statePath, { force: true });
      log.info('Module slot state cleared', { moduleId });
    }
  }
}
