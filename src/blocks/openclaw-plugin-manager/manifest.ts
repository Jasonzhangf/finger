/**
 * OpenClaw Plugin Manifest Parser
 * Parses openclaw.plugin.json files
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OpenClawPluginManifest, PackageJsonOpenClawExtension, PluginConfigUiHint } from './types.js';

export const PLUGIN_MANIFEST_FILENAME = 'openclaw.plugin.json';

export type PluginManifestLoadResult =
  | { ok: true; manifest: OpenClawPluginManifest; manifestPath: string }
  | { ok: false; error: string; manifestPath: string };

export type PackageExtensionResult =
  | { ok: true; extensions: string[]; pluginId: string }
  | { ok: false; error: string };

/**
 * Load plugin manifest from directory
 */
export function loadPluginManifest(pluginDir: string): PluginManifestLoadResult {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILENAME);

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      error: 'Plugin manifest not found: ' + manifestPath,
      manifestPath,
    };
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const raw = JSON.parse(content) as unknown;

    if (!isRecord(raw)) {
      return {
        ok: false,
        error: 'Plugin manifest must be an object',
        manifestPath,
      };
    }

    if (typeof raw.id !== 'string' || !raw.id) {
      return {
        ok: false,
        error: 'Plugin manifest must have a valid "id" field',
        manifestPath,
      };
    }

    const manifest: OpenClawPluginManifest = {
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined,
      kind: raw.kind as OpenClawPluginManifest['kind'],
      channels: normalizeStringArray(raw.channels),
      providers: normalizeStringArray(raw.providers),
      skills: normalizeStringArray(raw.skills),
      configSchema: isRecord(raw.configSchema) ? (raw.configSchema as Record<string, unknown>) : undefined,
      uiHints: isRecord(raw.uiHints) ? (raw.uiHints as Record<string, PluginConfigUiHint>) : undefined,
      capabilities: isRecord(raw.capabilities) ? (raw.capabilities as Record<string, boolean>) : undefined,
    };

    return { ok: true, manifest, manifestPath };
  } catch (err) {
    return {
      ok: false,
      error: 'Failed to parse plugin manifest: ' + String(err),
      manifestPath,
    };
  }
}

/**
 * Parse package.json for openclaw extension entries
 */
export function parsePackageJsonExtensions(packageJsonPath: string): PackageExtensionResult {
  try {
    if (!fs.existsSync(packageJsonPath)) {
      return { ok: false, error: 'package.json not found: ' + packageJsonPath };
    }

    const content = fs.readFileSync(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as unknown;

    if (!isRecord(pkg)) {
      return { ok: false, error: 'package.json must be an object' };
    }

    const openclaw = pkg.openclaw;
    if (!isRecord(openclaw)) {
      return { ok: false, error: 'package.json missing "openclaw" field' };
    }

    const pluginId = typeof openclaw.id === 'string' ? openclaw.id : '';
    if (!pluginId) {
      return { ok: false, error: 'package.json openclaw.id is required' };
    }

    const extensions = normalizeStringArray(openclaw.extensions);
    if (extensions.length === 0) {
      return { ok: false, error: 'package.json openclaw.extensions is empty or missing' };
    }

    return { ok: true, extensions, pluginId };
  } catch (err) {
    return { ok: false, error: 'Failed to parse package.json: ' + String(err) };
  }
}

/**
 * Resolve plugin entry files
 */
export function resolvePluginEntries(
  pluginDir: string,
  extensions: string[]
): { resolved: string[]; missing: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];

  for (const ext of extensions) {
    const entryPath = path.join(pluginDir, ext);
    if (fs.existsSync(entryPath)) {
      resolved.push(entryPath);
    } else {
      missing.push(entryPath);
    }
  }

  return { resolved, missing };
}

// Helper functions

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((s) => s.trim())
    .filter(Boolean);
}
