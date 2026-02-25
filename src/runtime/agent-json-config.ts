import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { RuntimeFacade } from './runtime-facade.js';

export interface AgentToolsConfig {
  whitelist?: string[];
  blacklist?: string[];
  authorizationRequired?: string[];
}

export interface AgentJsonConfig {
  id: string;
  name?: string;
  role?: string;
  tools?: AgentToolsConfig;
  model?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LoadedAgentConfig {
  filePath: string;
  config: AgentJsonConfig;
}

export interface AgentJsonLoadResult {
  dir: string;
  loaded: LoadedAgentConfig[];
  errors: Array<{ filePath: string; error: string }>;
}

export const AGENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    tools: {
      type: 'object',
      properties: {
        whitelist: { type: 'array', items: { type: 'string' } },
        blacklist: { type: 'array', items: { type: 'string' } },
        authorizationRequired: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    model: { type: 'object' },
    runtime: { type: 'object' },
    metadata: { type: 'object' },
  },
  additionalProperties: true,
};

export function resolveDefaultAgentConfigDir(): string {
  return process.env.FINGER_AGENT_CONFIG_DIR || path.join(homedir(), '.finger', 'agents');
}

export function loadAgentJsonConfigs(configDir = resolveDefaultAgentConfigDir()): AgentJsonLoadResult {
  const dir = path.resolve(configDir);
  if (!existsSync(dir)) {
    return { dir, loaded: [], errors: [] };
  }

  const candidateFiles = discoverAgentConfigFiles(dir);
  const loaded: LoadedAgentConfig[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];

  for (const filePath of candidateFiles) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      const config = parseAgentJsonConfig(parsed, filePath);
      loaded.push({ filePath, config });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ filePath, error: message });
    }
  }

  return { dir, loaded, errors };
}

export function applyAgentJsonConfigs(runtime: RuntimeFacade, configs: AgentJsonConfig[]): void {
  for (const config of configs) {
    runtime.clearAgentToolPolicy(config.id);

    if (config.role) {
      try {
        runtime.applyAgentRoleToolPolicy(config.id, config.role);
      } catch {
        // role preset is optional; explicit whitelist/blacklist below still applies
      }
    }

    const whitelist = config.tools?.whitelist ?? [];
    const blacklist = config.tools?.blacklist ?? [];
    const authorizationRequired = config.tools?.authorizationRequired ?? [];

    if (whitelist.length > 0) {
      runtime.setAgentToolWhitelist(config.id, whitelist);
    }
    if (blacklist.length > 0) {
      runtime.setAgentToolBlacklist(config.id, blacklist);
    }
    for (const toolName of authorizationRequired) {
      runtime.setToolAuthorizationRequired(toolName, true);
    }
  }
}

function discoverAgentConfigFiles(rootDir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolute = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.agent.json')) {
      files.push(absolute);
      continue;
    }

    if (entry.isDirectory()) {
      const nestedAgentJson = path.join(absolute, 'agent.json');
      if (existsSync(nestedAgentJson)) {
        files.push(nestedAgentJson);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export function parseAgentJsonConfig(value: unknown, sourcePath: string): AgentJsonConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent.json at ${sourcePath}: expected object`);
  }

  const config: AgentJsonConfig = {
    id: requireString(value, 'id', sourcePath),
  };

  if (typeof value.name === 'string') config.name = value.name;
  if (typeof value.role === 'string') config.role = value.role;

  if (value.tools !== undefined) {
    if (!isRecord(value.tools)) {
      throw new Error(`Invalid agent.json at ${sourcePath}: tools must be object`);
    }
    config.tools = {
      whitelist: parseStringArray(value.tools.whitelist, 'tools.whitelist', sourcePath),
      blacklist: parseStringArray(value.tools.blacklist, 'tools.blacklist', sourcePath),
      authorizationRequired: parseStringArray(
        value.tools.authorizationRequired,
        'tools.authorizationRequired',
        sourcePath,
      ),
    };
  }

  if (isRecord(value.model)) config.model = value.model;
  if (isRecord(value.runtime)) config.runtime = value.runtime;
  if (isRecord(value.metadata)) config.metadata = value.metadata;

  return config;
}

function parseStringArray(
  value: unknown,
  fieldName: string,
  sourcePath: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid agent.json at ${sourcePath}: ${fieldName} must be string[]`);
  }
  return Array.from(new Set(value.map((item) => item.trim()).filter((item) => item.length > 0)));
}

function requireString(record: Record<string, unknown>, field: string, sourcePath: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid agent.json at ${sourcePath}: field "${field}" must be non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
