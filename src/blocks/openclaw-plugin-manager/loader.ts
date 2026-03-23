/**
 * OpenClaw Plugin Loader
 * Dynamically loads plugin modules
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { PluginRecord, LoadPluginResult, PluginRuntimeApi, PluginLogger } from './types.js';
import { loadPluginManifest, parsePackageJsonExtensions, resolvePluginEntries } from './manifest.js';
import { discoverPluginsWithPriority, type DiscoveredPluginPath } from './discovery.js';
import { createOpenClawRuntimeApi, normalizePluginDefinition } from './openclaw-api-adapter.js';
import type { OpenClawGateBlock } from '../openclaw-gate/index.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Loader');

const log = logger.module('Loader');

/** Lazy-loaded jiti instance (CJS require hook for .ts/.tsx files) */
let _jitiRequire: ((id: string) => unknown) | null = null;
const cjsRequire = createRequire(import.meta.url);

function getJitiRequire(): ((id: string) => unknown) | null {
  if (_jitiRequire) return _jitiRequire;
  try {
    // openclaw ships jiti in its node_modules
    const jitiPath = cjsRequire.resolve('jiti', { paths: ['/opt/homebrew/lib/node_modules/openclaw/node_modules'] });
    const { createJiti } = cjsRequire(jitiPath);
    // createJiti needs a real filename — use this file's path
    _jitiRequire = createJiti(fileURLToPath(import.meta.url), { interopDefault: true });
    return _jitiRequire;
  } catch {
    return null;
  }
}

/**
 * Import a module, falling back to jiti for .ts entries.
 * jiti can load .ts files at runtime when openclaw is installed globally.
 */
async function smartImport(entryPath: string): Promise<unknown> {
  const tsLike = /\.(ts|tsx|mts|cts)$/.test(entryPath);

  // For source plugins (standard npm packages with TS entries), prefer jiti first.
  if (tsLike) {
    const jitiRequire = getJitiRequire();
    if (jitiRequire) {
      try {
        return jitiRequire(entryPath);
      } catch {
        // continue to native import fallback
      }
    }
  }

  // Native ESM import path (works for .js/.mjs and some transpiled entries)
  try {
    return await import(pathToFileURL(entryPath).href);
  } catch {
    if (tsLike) {
      // Second chance with jiti for TS entries
      const jitiRequire = getJitiRequire();
      if (!jitiRequire) return null;
      try {
        return jitiRequire(entryPath);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function resolveEntriesWithManifestFallback(
  pluginPath: string,
  packageJsonPath: string,
  manifestPresent: boolean,
): string[] {
  const extResult = parsePackageJsonExtensions(packageJsonPath);
  if (extResult.ok) {
    return resolvePluginEntries(pluginPath, extResult.extensions).resolved;
  }

  // Standard npm plugin fallback:
  // Some packages rely on openclaw.plugin.json for id and only keep
  // openclaw.extensions in package.json. In that case we still accept extensions.
  if (manifestPresent) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        openclaw?: { extensions?: unknown };
      };
      const extRaw = pkg.openclaw?.extensions;
      const extensions = Array.isArray(extRaw)
        ? extRaw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (extensions.length > 0) {
        return resolvePluginEntries(pluginPath, extensions).resolved;
      }
    } catch {
      // ignore and return empty entries
    }
  }

  return [];
}


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
    entries = resolveEntriesWithManifestFallback(pluginPath, packageJsonPath, manifestResult.ok);
  }

  let pluginModule: unknown = null;
  let lastError: string | null = null;

  for (const entry of entries) {
    try {
      const imported = await smartImport(entry) as any;
      if (!imported) {
        lastError = `Loader returned empty module for ${entry}`;
        logger.warn?.(lastError);
        continue;
      }

      const normalized = imported?.default ?? imported;
      if (!normalized || (typeof normalized !== 'object' && typeof normalized !== 'function')) {
        lastError = `Loader returned invalid module shape for ${entry}`;
        logger.warn?.(lastError);
        continue;
      }

      pluginModule = normalized;
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
