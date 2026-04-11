/**
 * ModuleLayers - 模块分层加载器与校验器
 *
 * 职责：
 * 1. 加载 ~/.finger/config/module-layers.json
 * 2. 解析模块层级归属（core vs extension）
 * 3. 提供依赖图查询与依赖顺序解析
 * 4. 升级策略门禁判断
 */

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { logger } from '../core/logger.js';

const log = logger.module('ModuleLayers');

export type ModuleTier = 'core' | 'extension' | 'unknown';
export type UpgradePolicyType = 'full' | 'hot' | 'unknown';

export interface LayerConfig {
  description: string;
  upgradePolicy: 'full' | 'hot';
  requiresRestart: boolean;
  modules: string[];
  paths: string[];
  extensionPaths?: string[];
  isolation?: string;
}

export interface ModuleLayersConfig {
  version: number;
  description: string;
  layers: {
    core: LayerConfig;
    extension: LayerConfig;
  };
  dependencies: Record<string, string[]>;
  upgradeTriggers: {
    default: string;
    options: string[];
  };
  rollback: {
    maxPoints: number;
    storagePath: string;
  };
}

export interface DependencyNode {
  moduleId: string;
  tier: ModuleTier;
  dependencies: string[];
}

export interface UpgradePlan {
  moduleId: string;
  targetVersion: string;
  upgradeType: UpgradePolicyType;
  requiresRestart: boolean;
  dependencyOrder: string[];
}

export class ModuleLayersManager {
  private config: ModuleLayersConfig | null = null;
  private loaded = false;
  private moduleTierCache = new Map<string, ModuleTier>();

  resolveLayersConfigPath(): string {
    return resolve(homedir(), '.finger', 'config', 'module-layers.json');
  }

  async load(configPath?: string): Promise<ModuleLayersConfig> {
    if (this.loaded && this.config) return this.config;

    const path = configPath || this.resolveLayersConfigPath();
    if (!existsSync(path)) {
      throw new Error(`Module layers config not found: ${path}`);
    }

    try {
      const raw = readFileSync(path, 'utf-8');
      this.config = JSON.parse(raw) as ModuleLayersConfig;
      this.loaded = true;

      log.info('Module layers loaded', {
        coreModules: this.config.layers.core.modules.length,
        extensionModules: this.config.layers.extension.modules.length,
        dependencyCount: Object.keys(this.config.dependencies).length,
      });

      return this.config;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse module-layers.json: ${message}`);
    }
  }

  getConfig(): ModuleLayersConfig {
    if (!this.loaded || !this.config) {
      throw new Error('Module layers not loaded. Call load() first.');
    }
    return this.config;
  }

  getModuleTier(moduleId: string): ModuleTier {
    if (this.moduleTierCache.has(moduleId)) {
      return this.moduleTierCache.get(moduleId)!;
    }

    const config = this.getConfig();

    // Check core modules
    if (this.matchesAnyPattern(moduleId, config.layers.core.modules)) {
      this.moduleTierCache.set(moduleId, 'core');
      return 'core';
    }

    // Check extension modules
    if (this.matchesAnyPattern(moduleId, config.layers.extension.modules)) {
      this.moduleTierCache.set(moduleId, 'extension');
      return 'extension';
    }

    // Fallback: check paths
    if (this._moduleIdMatchesPaths(moduleId, config.layers.core.paths)) {
      this.moduleTierCache.set(moduleId, 'core');
      return 'core';
    }

    if (this._moduleIdMatchesPaths(moduleId, config.layers.extension.paths)) {
      this.moduleTierCache.set(moduleId, 'extension');
      return 'extension';
    }

    this.moduleTierCache.set(moduleId, 'unknown');
    return 'unknown';
  }

  getUpgradePolicy(moduleId: string): { type: UpgradePolicyType; requiresRestart: boolean } {
    const tier = this.getModuleTier(moduleId);

    if (tier === 'core') {
      return { type: 'full', requiresRestart: true };
    }

    if (tier === 'extension') {
      return { type: 'hot', requiresRestart: false };
    }

    return { type: 'unknown', requiresRestart: false };
  }

  getDependencies(moduleId: string): string[] {
    const config = this.getConfig();
    return config.dependencies[moduleId] ?? [];
  }

  /**
   * 解析升级依赖顺序（拓扑排序）
   * 确保被依赖模块先升级
   */
  resolveDependencyOrder(moduleId: string): string[] {
    const visited = new Set<string>();
    const order: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const deps = this.getDependencies(id);
      for (const dep of deps) {
        visit(dep);
      }

      if (!order.includes(id)) {
        order.push(id);
      }
    };

    visit(moduleId);
    return order;
  }

  /**
   * 验证模块依赖是否满足
   */
  validateDependencies(moduleId: string): { ok: boolean; missing: string[] } {
    const deps = this.getDependencies(moduleId);
    const missing: string[] = [];

    for (const dep of deps) {
      const tier = this.getModuleTier(dep);
      if (tier === 'unknown') {
        missing.push(dep);
      }
    }

    return { ok: missing.length === 0, missing };
  }

  /**
   * 检查变更是否影响 Core 层（需要完整升级）
   */
  affectsCoreLayer(changedPaths: string[]): boolean {
    const config = this.getConfig();
    const corePaths = config.layers.core.paths;

    for (const changedPath of changedPaths) {
      for (const corePath of corePaths) {
        if (changedPath.startsWith(corePath.replace(/\*$/, ''))) {
          return true;
        }
      }
    }

    return false;
  }

  // ── Private helpers ──

  private matchesAnyPattern(moduleId: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchesPattern(moduleId, pattern));
  }

  private matchesPattern(moduleId: string, pattern: string): boolean {
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
      return regex.test(moduleId);
    }
    return moduleId === pattern;
  }

  private _moduleIdMatchesPaths(moduleId: string, paths: string[]): boolean {
    const normalizedModuleId = moduleId.replace(/-/g, '/');
    return paths.some(p => {
      const normalized = p.replace(/\*$/, '').replace(/\//g, '/');
      return normalizedModuleId.startsWith(normalized.replace(/^src\//, ''));
    });
  }
}

export const moduleLayers = new ModuleLayersManager();
