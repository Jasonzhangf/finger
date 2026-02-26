import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type {
  AgentGovernanceRuntimeConfig,
  AgentProviderRuntimeConfig,
  AgentRuntimeConfig,
  AgentSessionRuntimeConfig,
  RuntimeFacade,
} from './runtime-facade.js';

export interface AgentToolsConfig {
  whitelist?: string[];
  blacklist?: string[];
  authorizationRequired?: string[];
}

export type AgentJsonProviderConfig = AgentProviderRuntimeConfig;

export type AgentJsonSessionConfig = AgentSessionRuntimeConfig;

export type AgentJsonGovernanceConfig = AgentGovernanceRuntimeConfig;

export interface AgentJsonConfig {
  id: string;
  name?: string;
  role?: string;
  provider?: AgentJsonProviderConfig;
  session?: AgentJsonSessionConfig;
  governance?: AgentJsonGovernanceConfig;
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

const SESSION_BINDING_SCOPES = ['finger', 'finger+agent'] as const;
const IFLOW_APPROVAL_MODES = ['default', 'autoEdit', 'yolo', 'plan'] as const;

export const AGENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    provider: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string' },
        model: { type: 'string' },
        options: { type: 'object' },
      },
      additionalProperties: true,
    },
    session: {
      type: 'object',
      properties: {
        bindingScope: { type: 'string', enum: ['finger', 'finger+agent'] },
        resume: { type: 'boolean' },
        provider: { type: 'string' },
        agentId: { type: 'string' },
        mapPath: { type: 'string' },
      },
      additionalProperties: false,
    },
    governance: {
      type: 'object',
      properties: {
        iflow: {
          type: 'object',
          properties: {
            allowedTools: { type: 'array', items: { type: 'string' } },
            disallowedTools: { type: 'array', items: { type: 'string' } },
            approvalMode: { type: 'string', enum: ['default', 'autoEdit', 'yolo', 'plan'] },
            injectCapabilities: { type: 'boolean' },
            capabilityIds: { type: 'array', items: { type: 'string' } },
            commandNamespace: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
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
    runtime.clearAgentRuntimeConfig(config.id);

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

    const runtimeConfig: AgentRuntimeConfig = {
      id: config.id,
      name: config.name,
      role: config.role,
      provider: config.provider,
      session: config.session,
      governance: config.governance,
      model: config.model,
      runtime: config.runtime,
      metadata: config.metadata,
    };
    runtime.setAgentRuntimeConfig(config.id, runtimeConfig);
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
  if (value.provider !== undefined) {
    config.provider = parseProviderConfig(value.provider, sourcePath);
  }
  if (value.session !== undefined) {
    config.session = parseSessionConfig(value.session, sourcePath);
  }
  if (value.governance !== undefined) {
    config.governance = parseGovernanceConfig(value.governance, sourcePath);
  }

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

function parseProviderConfig(value: unknown, sourcePath: string): AgentJsonProviderConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent.json at ${sourcePath}: provider must be object`);
  }

  const provider: AgentJsonProviderConfig = {
    type: requireString(value, 'type', sourcePath),
  };
  if (typeof value.model === 'string' && value.model.trim().length > 0) {
    provider.model = value.model.trim();
  }
  if (isRecord(value.options)) {
    provider.options = value.options;
  }
  return provider;
}

function parseSessionConfig(value: unknown, sourcePath: string): AgentJsonSessionConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent.json at ${sourcePath}: session must be object`);
  }
  assertNoExtraKeys(value, ['bindingScope', 'resume', 'provider', 'agentId', 'mapPath'], 'session', sourcePath);

  const session: AgentJsonSessionConfig = {};
  if (value.bindingScope !== undefined) {
    session.bindingScope = parseEnumValue(
      value.bindingScope,
      SESSION_BINDING_SCOPES,
      'session.bindingScope',
      sourcePath,
    );
  }
  if (value.resume !== undefined) {
    if (typeof value.resume !== 'boolean') {
      throw new Error(`Invalid agent.json at ${sourcePath}: session.resume must be boolean`);
    }
    session.resume = value.resume;
  }
  if (typeof value.provider === 'string' && value.provider.trim().length > 0) {
    session.provider = value.provider.trim();
  }
  if (typeof value.agentId === 'string' && value.agentId.trim().length > 0) {
    session.agentId = value.agentId.trim();
  }
  if (typeof value.mapPath === 'string' && value.mapPath.trim().length > 0) {
    session.mapPath = value.mapPath.trim();
  }
  return session;
}

function parseGovernanceConfig(value: unknown, sourcePath: string): AgentJsonGovernanceConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid agent.json at ${sourcePath}: governance must be object`);
  }
  assertNoExtraKeys(value, ['iflow'], 'governance', sourcePath);

  const governance: AgentJsonGovernanceConfig = {};
  if (value.iflow !== undefined) {
    if (!isRecord(value.iflow)) {
      throw new Error(`Invalid agent.json at ${sourcePath}: governance.iflow must be object`);
    }
    assertNoExtraKeys(
      value.iflow,
      ['allowedTools', 'disallowedTools', 'approvalMode', 'injectCapabilities', 'capabilityIds', 'commandNamespace'],
      'governance.iflow',
      sourcePath,
    );

    const iflow: NonNullable<AgentJsonGovernanceConfig['iflow']> = {};
    if (value.iflow.allowedTools !== undefined) {
      iflow.allowedTools = parseStringArray(value.iflow.allowedTools, 'governance.iflow.allowedTools', sourcePath);
    }
    if (value.iflow.disallowedTools !== undefined) {
      iflow.disallowedTools = parseStringArray(
        value.iflow.disallowedTools,
        'governance.iflow.disallowedTools',
        sourcePath,
      );
    }
    if (value.iflow.approvalMode !== undefined) {
      iflow.approvalMode = parseEnumValue(
        value.iflow.approvalMode,
        IFLOW_APPROVAL_MODES,
        'governance.iflow.approvalMode',
        sourcePath,
      );
    }
    if (value.iflow.injectCapabilities !== undefined) {
      if (typeof value.iflow.injectCapabilities !== 'boolean') {
        throw new Error(`Invalid agent.json at ${sourcePath}: governance.iflow.injectCapabilities must be boolean`);
      }
      iflow.injectCapabilities = value.iflow.injectCapabilities;
    }
    if (value.iflow.capabilityIds !== undefined) {
      iflow.capabilityIds = parseStringArray(
        value.iflow.capabilityIds,
        'governance.iflow.capabilityIds',
        sourcePath,
      );
    }
    if (typeof value.iflow.commandNamespace === 'string' && value.iflow.commandNamespace.trim().length > 0) {
      iflow.commandNamespace = value.iflow.commandNamespace.trim();
    }

    governance.iflow = iflow;
  }
  return governance;
}

function parseEnumValue<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fieldName: string,
  sourcePath: string,
): T {
  if (typeof value !== 'string') {
    throw new Error(`Invalid agent.json at ${sourcePath}: ${fieldName} must be string`);
  }
  if (!allowedValues.includes(value as T)) {
    throw new Error(
      `Invalid agent.json at ${sourcePath}: ${fieldName} must be one of ${allowedValues.join('|')}`,
    );
  }
  return value as T;
}

function assertNoExtraKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldName: string,
  sourcePath: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid agent.json at ${sourcePath}: ${fieldName}.${key} is not allowed`);
    }
  }
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
