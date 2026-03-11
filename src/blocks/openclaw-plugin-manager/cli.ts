/**
 * OpenClaw Plugin Manager CLI
 */

import type { PluginManager } from './index.js';
import type { PluginSource } from './types.js';

export type PluginCliDeps = {
  manager: PluginManager;
  output: (msg: string) => void;
};

/**
 * Handle plugin install command
 */
export async function handlePluginInstall(
  deps: PluginCliDeps,
  args: { source: string; force?: boolean }
): Promise<void> {
  const { manager, output } = deps;
  const source = parseSource(args.source);

  if (!source) {
    output('Error: Invalid source. Use npm:<package>, local:<path>, or git:<url>');
    return;
  }

  const result = await manager.install(source, args.force);

  if (result.ok) {
    output('Plugin installed: ' + result.pluginId + ' at ' + result.targetDir);
  } else {
    output('Install failed: ' + result.error);
  }
}

/**
 * Handle plugin uninstall command
 */
export async function handlePluginUninstall(
  deps: PluginCliDeps,
  args: { pluginId: string }
): Promise<void> {
  const { manager, output } = deps;
  const result = await manager.uninstall(args.pluginId);

  if (result.ok) {
    output('Plugin uninstalled: ' + args.pluginId);
  } else {
    output('Uninstall failed: ' + result.error);
  }
}

/**
 * Handle plugin list command
 */
export function handlePluginList(deps: PluginCliDeps): void {
  const { manager, output } = deps;
  const plugins = manager.getAllPlugins();

  if (plugins.length === 0) {
    output('No plugins installed');
    return;
  }

  output('Installed plugins:');
  for (const plugin of plugins) {
    const status = plugin.enabled ? 'enabled' : 'disabled';
    output('  - ' + plugin.id + ' (' + status + ') - ' + (plugin.manifest.version || 'no version'));
  }
}

/**
 * Parse source string into PluginSource
 */
function parseSource(source: string): PluginSource | null {
  if (source.startsWith('npm:')) {
    return { type: 'npm', spec: source.slice(4) };
  }
  if (source.startsWith('local:')) {
    return { type: 'local', path: source.slice(6) };
  }
  if (source.startsWith('git:')) {
    return { type: 'git', url: source.slice(4) };
  }
  // Default to npm
  if (!source.includes(':') && !source.startsWith('/')) {
    return { type: 'npm', spec: source };
  }
  // Local path
  if (source.startsWith('/') || source.startsWith('.')) {
    return { type: 'local', path: source };
  }
  return null;
}
