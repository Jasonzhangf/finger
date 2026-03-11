/**
 * OpenClaw Plugin Loader
 * Dynamically loads plugin modules
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PluginRecord, LoadPluginResult, OpenClawPluginDefinition, PluginRuntimeApi, PluginLogger } from './types.js';
import { loadPluginManifest, parsePackageJsonExtensions, resolvePluginEntries } from './manifest.js';

export type LoaderOptions = {
  pluginDir: string;
  logger?: PluginLogger;
};

const defaultLogger: PluginLogger = {
  info: (msg: string) => console.log(`[PluginLoader] INFO: ${msg}`),
  warn: (msg: string) => console.warn(`[PluginLoader] WARN: ${msg}`),
  error: (msg: string) => console.error(`[PluginLoader] ERROR: ${msg}`),
};

/**
 * Discover all plugins in directory
 */
export function discoverPlugins(pluginDir: string): string[] {
  if (!fs.existsSync(pluginDir)) {
    return [];
  }
  
  const plugins: string[] = [];
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const pluginPath = path.join(pluginDir, entry.name);
      const manifestPath = path.join(pluginPath, 'openclaw.plugin.json');
      const packagePath = path.join(pluginPath, 'package.json');
      
      if (fs.existsSync(manifestPath) || fs.existsSync(packagePath)) {
        plugins.push(pluginPath);
      }
    }
  }
  
  return plugins;
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
  
  // Load manifest
  const manifestResult = loadPluginManifest(pluginPath);
  let manifest: import('./types.js').OpenClawPluginManifest;
  
  if (!manifestResult.ok) {
    // Try package.json
    const packageJsonPath = path.join(pluginPath, 'package.json');
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
  
  // Resolve plugin entries
  const packageJsonPath = path.join(pluginPath, 'package.json');
  let entries: string[] = [];
  
  if (fs.existsSync(packageJsonPath)) {
    const extResult = parsePackageJsonExtensions(packageJsonPath);
    if (extResult.ok) {
      entries = resolvePluginEntries(pluginPath, extResult.extensions).resolved;
    }
  }
  
  // Try to load each entry
  let pluginModule: unknown = null;
  let lastError: string | null = null;
  
  for (const entry of entries) {
    try {
      // Dynamic import
      const imported = await import(entry);
      pluginModule = imported?.default ?? imported;
      logger.info?.(`Loaded plugin entry: ${entry}`);
      break;
    } catch (err) {
      lastError = `Failed to load ${entry}: ${err}`;
      logger.warn?.(lastError);
    }
  }
  
  // Call register if available
  if (pluginModule && isPluginDefinition(pluginModule)) {
    if (pluginModule.register) {
      try {
        await pluginModule.register(runtimeApi);
        logger.info?.(`Registered plugin: ${manifest.id}`);
      } catch (err) {
        logger.error?.(`Failed to register plugin ${manifest.id}: ${err}`);
      }
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
  const pluginPaths = discoverPlugins(pluginDir);
  const records: PluginRecord[] = [];
  
  for (const pluginPath of pluginPaths) {
    const result = await loadPlugin(pluginPath, runtimeApi, options);
    
    if (result.ok) {
      records.push({
        id: result.pluginId,
        manifest: result.manifest,
        installDir: pluginPath,
        enabled: true,
        module: result.module,
      });
    } else {
      logger.warn?.(`Failed to load plugin at ${pluginPath}: ${result.error}`);
    }
  }
  
  return records;
}

/**
 * Type guard for plugin definition
 */
function isPluginDefinition(value: unknown): value is OpenClawPluginDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as OpenClawPluginDefinition).id === 'string'
  );
}
