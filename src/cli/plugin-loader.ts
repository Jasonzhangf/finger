import { Command } from 'commander';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { loadModuleManifest } from '../orchestration/module-manifest.js';
import { FINGER_PATHS } from '../core/finger-paths.js';

const PLUGIN_FILENAME_SUFFIX = '.module.json';
export type CliPluginMode = 'plugin' | 'capability';

export interface CliPluginContext {
  defaultHttpBaseUrl: string;
  defaultWsUrl: string;
  cliVersion: string;
}

export interface CliPlugin {
  register: (program: Command, context: CliPluginContext) => void | Promise<void>;
}

export interface InstalledCliPlugin {
  id: string;
  name: string;
  version: string;
  mode: CliPluginMode;
  enabled: boolean;
  manifestPath: string;
  entryPath: string;
}

export function resolveCliPluginDir(mode: CliPluginMode = 'plugin'): string {
  if (mode === 'capability') {
    return process.env.FINGER_CLI_CAPABILITY_DIR || FINGER_PATHS.runtime.capabilitiesCliDir;
  }
  return process.env.FINGER_CLI_PLUGIN_DIR || FINGER_PATHS.runtime.pluginsCliDir;
}

export function ensureCliPluginDir(mode: CliPluginMode = 'plugin'): string {
  const pluginDir = resolveCliPluginDir(mode);
  if (!existsSync(pluginDir)) {
    mkdirSync(pluginDir, { recursive: true });
  }
  return pluginDir;
}

function resolveAllCliPluginDirs(): Array<{ mode: CliPluginMode; dir: string }> {
  const pluginDir = ensureCliPluginDir('plugin');
  const capabilityDir = ensureCliPluginDir('capability');
  return [
    { mode: 'plugin', dir: pluginDir },
    { mode: 'capability', dir: capabilityDir },
  ];
}

export function listInstalledCliPlugins(): InstalledCliPlugin[] {
  const plugins: InstalledCliPlugin[] = [];

  for (const { mode, dir } of resolveAllCliPluginDirs()) {
    const entries = readdirSync(dir).filter((file) => file.endsWith(PLUGIN_FILENAME_SUFFIX));
    for (const file of entries) {
      const manifestPath = path.join(dir, file);
      try {
        const { manifest, entryPath } = loadModuleManifest(manifestPath);
        if (manifest.type !== 'cli-plugin') continue;

        plugins.push({
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          mode,
          enabled: manifest.enabled !== false,
          manifestPath,
          entryPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[CLI Plugin] Skip invalid manifest ${manifestPath}: ${message}`);
      }
    }
  }

  return plugins.sort((a, b) => `${a.mode}:${a.id}`.localeCompare(`${b.mode}:${b.id}`));
}

export function installCliPluginManifest(
  sourceManifestPath: string,
  mode: CliPluginMode = 'plugin',
): InstalledCliPlugin {
  const resolvedSource = path.resolve(sourceManifestPath);
  const { manifest, entryPath } = loadModuleManifest(resolvedSource);
  if (manifest.type !== 'cli-plugin') {
    throw new Error(`Manifest type must be "cli-plugin": ${resolvedSource}`);
  }

  if (!existsSync(entryPath)) {
    throw new Error(`Plugin entry does not exist: ${entryPath}`);
  }

  const pluginDir = ensureCliPluginDir(mode);
  const installedManifestPath = path.join(pluginDir, `${manifest.id}${PLUGIN_FILENAME_SUFFIX}`);

  const normalized = {
    id: manifest.id,
    type: 'cli-plugin',
    name: manifest.name,
    version: manifest.version,
    entry: entryPath,
    enabled: manifest.enabled !== false,
    description: manifest.description,
  };
  writeFileSync(installedManifestPath, JSON.stringify(normalized, null, 2), 'utf-8');

  return {
    id: normalized.id,
    name: normalized.name,
    version: normalized.version,
    mode,
    enabled: normalized.enabled,
    manifestPath: installedManifestPath,
    entryPath: normalized.entry,
  };
}

export function removeCliPluginManifest(pluginId: string, mode?: CliPluginMode): boolean {
  const targets = mode
    ? [{ mode, dir: ensureCliPluginDir(mode) }]
    : resolveAllCliPluginDirs();

  for (const target of targets) {
    const manifestPath = path.join(target.dir, `${pluginId}${PLUGIN_FILENAME_SUFFIX}`);
    if (!existsSync(manifestPath)) continue;
    rmSync(manifestPath);
    return true;
  }

  return false;
}

export async function loadDynamicCliPlugins(
  program: Command,
  context: CliPluginContext,
): Promise<{ loaded: string[]; failed: Array<{ id: string; error: string }> }> {
  const installed = listInstalledCliPlugins();
  const loaded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const plugin of installed) {
    if (!plugin.enabled) continue;
    try {
      const moduleExports = await import(pathToFileURL(plugin.entryPath).href);
      const candidate = (moduleExports.default ?? moduleExports) as unknown;
      if (!isCliPlugin(candidate)) {
        throw new Error(`Plugin entry must export { register(program, context) }`);
      }

      await candidate.register(program, context);
      loaded.push(plugin.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ id: plugin.id, error: message });
      console.error(`[CLI Plugin] Failed to load "${plugin.id}": ${message}`);
    }
  }

  return { loaded, failed };
}

export function registerPluginCommand(program: Command): void {
  const plugin = program.command('plugin').description('CLI 插件管理（module.json 动态加载）');

  plugin
    .command('list')
    .description('列出已安装 CLI 插件')
    .action(() => {
      const installed = listInstalledCliPlugins();
      if (installed.length === 0) {
        console.log('No CLI plugins installed');
        process.exit(0);
        return;
      }
      installed.forEach((item) => {
        console.log(
          `[${item.mode}] ${item.id} (${item.version}) enabled=${item.enabled} entry=${item.entryPath}`,
        );
      });
      process.exit(0);
    });

  plugin
    .command('register')
    .description('注册 CLI 插件/能力（复制 module.json 到运行时目录）')
    .requiredOption('-m, --manifest <path>', 'Path to plugin module.json')
    .option('--mode <mode>', 'plugin | capability', 'plugin')
    .action((options: { manifest: string; mode: string }) => {
      try {
        const mode = parseMode(options.mode);
        const installed = installCliPluginManifest(options.manifest, mode);
        console.log(`CLI ${installed.mode} installed: ${installed.id}`);
        console.log(`Manifest: ${installed.manifestPath}`);
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[CLI Plugin] Register failed: ${message}`);
        process.exit(1);
      }
    });

  plugin
    .command('unregister')
    .description('移除已安装 CLI 插件/能力')
    .requiredOption('-i, --id <id>', 'Plugin id')
    .option('--mode <mode>', 'plugin | capability')
    .action((options: { id: string; mode?: string }) => {
      const removed = removeCliPluginManifest(options.id, options.mode ? parseMode(options.mode) : undefined);
      if (!removed) {
        console.error(`[CLI Plugin] Not found: ${options.id}`);
        process.exit(1);
        return;
      }
      console.log(`CLI plugin removed: ${options.id}`);
      process.exit(0);
    });

  plugin
    .command('register-file')
    .description('快速注册：复制 JS 文件并生成 module.json（适合直接挂载）')
    .requiredOption('-i, --id <id>', 'Plugin id')
    .requiredOption('-n, --name <name>', 'Plugin name')
    .requiredOption('-f, --file <path>', 'Path to plugin JS file')
    .option('-v, --version <version>', 'Plugin version', '1.0.0')
    .option('--mode <mode>', 'plugin | capability', 'plugin')
    .action((options: { id: string; name: string; file: string; version: string; mode: string }) => {
      try {
        const mode = parseMode(options.mode);
        const pluginDir = ensureCliPluginDir(mode);
        const sourceFile = path.resolve(options.file);
        if (!existsSync(sourceFile)) {
          throw new Error(`Plugin JS file not found: ${sourceFile}`);
        }

        const copiedJsPath = path.join(pluginDir, `${options.id}.js`);
        copyFileSync(sourceFile, copiedJsPath);

        const manifestPath = path.join(pluginDir, `${options.id}${PLUGIN_FILENAME_SUFFIX}`);
        writeFileSync(
          manifestPath,
          JSON.stringify(
            {
              id: options.id,
              type: 'cli-plugin',
              name: options.name,
              version: options.version,
              entry: copiedJsPath,
              enabled: true,
            },
            null,
            2,
          ),
          'utf-8',
        );

        console.log(`CLI ${mode} installed: ${options.id}`);
        console.log(`Entry: ${copiedJsPath}`);
        process.exit(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[CLI Plugin] register-file failed: ${message}`);
        process.exit(1);
      }
    });
}

function isCliPlugin(value: unknown): value is CliPlugin {
  if (!isRecord(value)) return false;
  return typeof value.register === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMode(mode: string): CliPluginMode {
  if (mode === 'plugin' || mode === 'capability') {
    return mode;
  }
  throw new Error(`Invalid mode: ${mode}. Expected "plugin" or "capability"`);
}
