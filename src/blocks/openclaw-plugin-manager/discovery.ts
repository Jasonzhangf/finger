import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function resolveFingerPluginRoots(pluginDir?: string, includeOpenClawGlobal = true): string[] {
  const roots: string[] = [];
  if (pluginDir && pluginDir.trim().length > 0) {
    roots.push(path.resolve(pluginDir.trim()));
  }

  if (includeOpenClawGlobal) {
    const openClawHome = process.env.OPENCLAW_STATE_DIR?.trim()
      || process.env.CLAWDBOT_STATE_DIR?.trim()
      || path.join(os.homedir(), '.openclaw');
    roots.push(path.join(openClawHome, 'extensions'));
  }

  return dedupePaths(roots).filter((candidate) => fs.existsSync(candidate));
}

export type DiscoveredPluginPath = {
  pluginId: string;
  pluginPath: string;
  sourceRoot: string;
  sourceKind: 'finger' | 'openclaw';
};

export function discoverPluginsWithPriority(pluginDir?: string, options?: { includeOpenClawGlobal?: boolean }): DiscoveredPluginPath[] {
  const roots = resolveFingerPluginRoots(pluginDir, options?.includeOpenClawGlobal ?? true);
  const results = new Map<string, DiscoveredPluginPath>();

  for (const root of roots) {
    const sourceKind: 'finger' | 'openclaw' = pluginDir && path.resolve(root) === path.resolve(pluginDir)
      ? 'finger'
      : 'openclaw';

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const pluginPath = path.join(root, entry.name);
      const pluginId = inferPluginId(pluginPath, entry.name);
      if (!pluginId) continue;

      const existing = results.get(pluginId);
      if (existing && existing.sourceKind === 'finger') {
        continue;
      }
      results.set(pluginId, { pluginId, pluginPath, sourceRoot: root, sourceKind });
    }
  }

  return Array.from(results.values()).sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

function inferPluginId(pluginPath: string, fallbackName: string): string | null {
  const manifestPath = path.join(pluginPath, 'openclaw.plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { id?: string };
      if (typeof raw.id === 'string' && raw.id.trim().length > 0) return raw.id.trim();
    } catch {
      return fallbackName;
    }
  }

  const packageJsonPath = path.join(pluginPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { openclaw?: { id?: string }, name?: string };
      if (typeof raw.openclaw?.id === 'string' && raw.openclaw.id.trim().length > 0) return raw.openclaw.id.trim();
      if (typeof raw.name === 'string' && raw.name.trim().length > 0) return raw.name.trim();
    } catch {
      return fallbackName;
    }
  }

  return null;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    deduped.push(resolved);
  }
  return deduped;
}
