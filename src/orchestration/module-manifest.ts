import { readFileSync } from 'fs';
import path from 'path';

export type SupportedModuleType = 'input' | 'output' | 'agent' | 'cli-plugin';

export interface ModuleManifest {
  id: string;
  type: SupportedModuleType;
  name: string;
  version: string;
  entry: string;
  enabled?: boolean;
  description?: string;
}

export interface ResolvedModuleManifest {
  manifest: ModuleManifest;
  manifestPath: string;
  entryPath: string;
}

export function loadModuleManifest(manifestPath: string): ResolvedModuleManifest {
  const absoluteManifestPath = path.resolve(manifestPath);
  const content = readFileSync(absoluteManifestPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid module.json at ${absoluteManifestPath}: ${message}`);
  }

  const manifest = parseModuleManifest(parsed, absoluteManifestPath);
  const entryPath = path.isAbsolute(manifest.entry)
    ? manifest.entry
    : path.resolve(path.dirname(absoluteManifestPath), manifest.entry);

  return {
    manifest,
    manifestPath: absoluteManifestPath,
    entryPath,
  };
}

export function parseModuleManifest(value: unknown, sourcePath: string): ModuleManifest {
  if (!isRecord(value)) {
    throw new Error(`Invalid module.json at ${sourcePath}: expected object`);
  }

  const manifest: ModuleManifest = {
    id: requireString(value, 'id', sourcePath),
    type: requireModuleType(value.type, sourcePath),
    name: requireString(value, 'name', sourcePath),
    version: requireString(value, 'version', sourcePath),
    entry: requireString(value, 'entry', sourcePath),
  };

  if (typeof value.enabled === 'boolean') {
    manifest.enabled = value.enabled;
  }
  if (typeof value.description === 'string') {
    manifest.description = value.description;
  }

  return manifest;
}

function requireModuleType(value: unknown, sourcePath: string): SupportedModuleType {
  if (
    value === 'input' ||
    value === 'output' ||
    value === 'agent' ||
    value === 'cli-plugin'
  ) {
    return value;
  }
  throw new Error(
    `Invalid module.json at ${sourcePath}: field "type" must be one of input/output/agent/cli-plugin`,
  );
}

function requireString(record: Record<string, unknown>, field: string, sourcePath: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid module.json at ${sourcePath}: field "${field}" must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
