/**
 * OpenClaw Plugin Loader
 * Dynamically loads plugin modules
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { PluginRecord, LoadPluginResult, PluginRuntimeApi, PluginLogger } from './types.js';
import { loadPluginManifest, parsePackageJsonExtensions, resolvePluginEntries } from './manifest.js';
import { discoverPluginsWithPriority, type DiscoveredPluginPath } from './discovery.js';
import { createOpenClawRuntimeApi, normalizePluginDefinition } from './openclaw-api-adapter.js';
import type { OpenClawGateBlock } from '../openclaw-gate/index.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Loader');

const log = logger.module('Loader');

export type LoaderOptions = {
  pluginDir: string;
  logger?: PluginLogger;
  gate?: OpenClawGateBlock;
  pluginConfigs?: Record<string, Record<string, unknown>>;
};

const defaultLogger: PluginLogger = {
  info: (msg: string) => clog.log(`[PluginLoader] INFO: ${msg}`),
  warn: (msg: string) => clog.warn(`[PluginLoader] WARN: ${msg}`),
  error: (msg: string) => clog.error(`[PluginLoader] ERROR: ${msg}`),
};

/**
 * Discover all plugins in directory with priority
 */
export function discoverPlugins(pluginDir: string, options?: { includeOpenClawGlobal?: boolean }): string[] {
  return discoverPluginsWithPriority(pluginDir, options).map((item) => item.pluginPath);
}

export function discoverPluginsDetailed(pluginDir: string, options?: { includeOpenClawGlobal?: boolean }): DiscoveredPluginPath[] {
  return discoverPluginsWithPriority(pluginDir, options);
}

/**
 * Load single plugin
 */
export async function loadPlugin(
  pluginPath: string,
  runtimeApi: PluginRuntimeApi,
  options: LoaderOptions
): Promise<LoadPluginResult> {
  const logger = options.logger || defaultLogger;

  const manifestResult = loadPluginManifest(pluginPath);
  let manifest: import('./types.js').OpenClawPluginManifest;

  if (!manifestResult.ok) {
    const packageJsonPath = `${pluginPath}/package.json`;
    if (fs.existsSync(packageJsonPath)) {
      const extResult = parsePackageJsonExtensions(packageJsonPath);
      if (extResult.ok) {
        const pkgContent = fs.readFileSync(packageJsonPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);
        manifest = {
          id: extResult.pluginId,
          name: pkg.name,
          description: pkg.description,
          version: pkg.version,
        };
      } else {
        return { ok: false, error: manifestResult.error };
      }
    } else {
      return { ok: false, error: manifestResult.error };
    }
  } else {
    manifest = manifestResult.manifest;
  }

  const packageJsonPath = `${pluginPath}/package.json`;
  let entries: string[] = [];

  if (fs.existsSync(packageJsonPath)) {
    const extResult = parsePackageJsonExtensions(packageJsonPath);
    if (extResult.ok) {
      entries = resolvePluginEntries(pluginPath, extResult.extensions).resolved;
    }
  }

  let pluginModule: unknown = null;
  let lastError: string | null = null;

  for (const entry of entries) {
    try {
      const imported = await import(pathToFileURL(entry).href);
      pluginModule = imported?.default ?? imported;
      logger.info?.(`Loaded plugin entry: ${entry}`);
      break;
    } catch (err) {
      lastError = `Failed to load ${entry}: ${err}`;
      logger.warn?.(lastError);
    }
  }

  if (!pluginModule && lastError) {
    return { ok: false, error: lastError };
  }

  const pluginDefinition = normalizePluginDefinition(pluginModule);
  if (pluginDefinition?.register && options.gate) {
    try {
      const compatApi = createOpenClawRuntimeApi({
        pluginId: manifest.id,
        gate: options.gate,
        logger,
        pluginConfig: options.pluginConfigs?.[manifest.id],
      });
      await pluginDefinition.register(compatApi);
      logger.info?.(`Registered plugin: ${manifest.id}`);
    } catch (err) {
      logger.error?.(`Failed to register plugin ${manifest.id}: ${err}`);
    }
  }

  return {
    ok: true,
    pluginId: manifest.id,
    module: pluginModule,
    manifest,
  };
}

/**
 * Load all plugins in directory
 */
export async function loadAllPlugins(
  pluginDir: string,
  runtimeApi: PluginRuntimeApi,
  options: LoaderOptions
): Promise<PluginRecord[]> {
  const logger = options.logger || defaultLogger;
  const discovered = discoverPluginsDetailed(pluginDir, { includeOpenClawGlobal: true });
  const records: PluginRecord[] = [];

  for (const discoveredPlugin of discovered) {
    const result = await loadPlugin(discoveredPlugin.pluginPath, runtimeApi, options);

    if (result.ok) {
      records.push({
        id: result.pluginId,
        manifest: result.manifest,
        installDir: discoveredPlugin.pluginPath,
        enabled: true,
        module: result.module,
        sourceKind: discoveredPlugin.sourceKind,
      });
    } else {
      logger.warn?.(`Failed to load plugin at ${discoveredPlugin.pluginPath}: ${result.error}`);
    }
  }

  return records;
}

