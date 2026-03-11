/**
 * OpenClaw Plugin Manager
 * OpenClaw-compatible plugin installation and loading
 */

import path from 'node:path';
import fs from 'node:fs';
import type { PluginSource, InstallPluginResult, PluginRecord, PluginRuntimeApi, PluginLogger } from './types.js';
import { installPlugin } from './installer.js';
import { loadAllPlugins, discoverPlugins } from './loader.js';
import type { OpenClawGateBlock } from '../openclaw-gate/index.js';

export type { OpenClawPluginManifest, PluginSource, InstallPluginResult, PluginRecord, PluginRuntimeApi, PluginLogger, OpenClawPluginDefinition } from './types.js';
export { loadPluginManifest, parsePackageJsonExtensions } from './manifest.js';
export { installPlugin } from './installer.js';
export { loadPlugin, loadAllPlugins, discoverPlugins } from './loader.js';

export type PluginManagerOptions = {
  pluginDir: string;
  logger?: PluginLogger;
  gate?: OpenClawGateBlock;
  pluginConfigs?: Record<string, Record<string, unknown>>;
};

const defaultLogger: PluginLogger = {
  info: (msg: string) => console.log('[PluginManager] INFO: ' + msg),
  warn: (msg: string) => console.warn('[PluginManager] WARN: ' + msg),
  error: (msg: string) => console.error('[PluginManager] ERROR: ' + msg),
};

/**
 * Plugin Manager - Main interface for plugin management
 */
export class PluginManager {
  private pluginDir: string;
  private logger: PluginLogger;
  private plugins: Map<string, PluginRecord> = new Map();
  private runtimeApi: PluginRuntimeApi;
  private gate?: OpenClawGateBlock;
  private pluginConfigs?: Record<string, Record<string, unknown>>;

  constructor(options: PluginManagerOptions) {
    this.pluginDir = options.pluginDir;
    this.logger = options.logger || defaultLogger;
    this.gate = options.gate;
    this.pluginConfigs = options.pluginConfigs;
    this.runtimeApi = this.createRuntimeApi();
  }

  /**
   * Install plugin from source
   */
  async install(source: PluginSource, force = false): Promise<InstallPluginResult> {
    const result = await installPlugin({
      pluginDir: this.pluginDir,
      source,
      force,
      logger: this.logger,
    });

    if (result.ok) {
      this.logger.info?.('Plugin installed: ' + result.pluginId);
    }

    return result;
  }

  /**
   * Uninstall plugin by ID
   */
  async uninstall(pluginId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const record = this.plugins.get(pluginId);

    if (!record) {
      const pluginPath = path.join(this.pluginDir, pluginId);
      if (fs.existsSync(pluginPath)) {
        fs.rmSync(pluginPath, { recursive: true, force: true });
        return { ok: true };
      }
      return { ok: false, error: 'Plugin not found: ' + pluginId };
    }

    this.plugins.delete(pluginId);

    try {
      fs.rmSync(record.installDir, { recursive: true, force: true });
      this.logger.info?.('Plugin uninstalled: ' + pluginId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'Failed to remove plugin directory: ' + String(err) };
    }
  }

  /**
   * Load all installed plugins
   */
  async loadAll(): Promise<PluginRecord[]> {
    const records = await loadAllPlugins(this.pluginDir, this.runtimeApi, {
      pluginDir: this.pluginDir,
      logger: this.logger,
      gate: this.gate,
      pluginConfigs: this.pluginConfigs,
    });

    for (const record of records) {
      this.plugins.set(record.id, record);
    }

    this.logger.info?.('Loaded ' + records.length + ' plugins');
    return records;
  }

  /**
   * Get plugin by ID
   */
  getPlugin(pluginId: string): PluginRecord | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all loaded plugins
   */
  getAllPlugins(): PluginRecord[] {
    return Array.from(this.plugins.values());
  }

  /**
   * List installed plugins
   */
  listInstalled(): string[] {
    return discoverPlugins(this.pluginDir, { includeOpenClawGlobal: false });
  }

  /**
   * Enable plugin
   */
  enable(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    if (record) {
      record.enabled = true;
      return true;
    }
    return false;
  }

  /**
   * Disable plugin
   */
  disable(pluginId: string): boolean {
    const record = this.plugins.get(pluginId);
    if (record) {
      record.enabled = false;
      return true;
    }
    return false;
  }

  /**
   * Create runtime API for plugins
   */
  private createRuntimeApi(): PluginRuntimeApi {
    return {
      registerChannel: (_channelIdOrRegistration: unknown, _handler?: unknown) => {
        this.logger.info?.('Channel registered');
      },
      registerTool: (_tool: unknown) => {
        this.logger.info?.('Tool registered');
      },
      registerHook: (_hook: unknown) => {
        this.logger.info?.('Hook registered');
      },
      registerService: (_service: unknown) => {
        this.logger.info?.('Service registered');
      },
      logger: this.logger,
    };
  }
}

/**
 * Create plugin manager instance
 */
export function createPluginManager(options: PluginManagerOptions): PluginManager {
  return new PluginManager(options);
}
