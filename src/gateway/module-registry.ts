import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { FINGER_PATHS } from '../core/finger-paths.js';
import path from 'path';
import { spawnSync } from 'child_process';
import { GatewayModuleManifest, GatewayProbeResult, ResolvedGatewayModule } from './types.js';

const MODULE_JSON_NAME = 'module.json';
const DEFAULT_README_FILE = 'README.md';
const DEFAULT_CLI_DOC_FILE = 'cli.md';
const DEFAULT_DOC_EXCERPT_LIMIT = 1200;

export function resolveGatewayDir(): string {
  return process.env.FINGER_GATEWAY_DIR || FINGER_PATHS.runtime.gatewaysDir;
}

export function ensureGatewayDir(): string {
  const dir = resolveGatewayDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function parseGatewayManifest(value: unknown, sourcePath: string): GatewayModuleManifest {
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: expected object`);
  }

  const id = requireString(value, 'id', sourcePath);
  const name = requireString(value, 'name', sourcePath);
  const version = requireString(value, 'version', sourcePath);
  const description = requireString(value, 'description', sourcePath);
  const direction = requireDirection(value.direction, sourcePath);
  const transport = requireTransport(value.transport, sourcePath);
  const mode = requireMode(value.mode, sourcePath);
  const processConfig = requireProcessConfig(value.process, sourcePath);

  const manifest: GatewayModuleManifest = {
    id,
    name,
    version,
    description,
    direction,
    transport,
    mode,
    process: processConfig,
  };

  if (isRecord(value.input) && typeof value.input.defaultTarget === 'string' && value.input.defaultTarget.trim().length > 0) {
    manifest.input = { defaultTarget: value.input.defaultTarget.trim() };
  }

  if (isRecord(value.docs)) {
    const docs: NonNullable<GatewayModuleManifest['docs']> = {};
    if (typeof value.docs.readmeFile === 'string' && value.docs.readmeFile.trim().length > 0) {
      docs.readmeFile = value.docs.readmeFile.trim();
    }
    if (typeof value.docs.cliDocFile === 'string' && value.docs.cliDocFile.trim().length > 0) {
      docs.cliDocFile = value.docs.cliDocFile.trim();
    }
    manifest.docs = docs;
  }

  if (typeof value.enabled === 'boolean') {
    manifest.enabled = value.enabled;
  }

  return manifest;
}

export function listGatewayModules(): ResolvedGatewayModule[] {
  const dir = ensureGatewayDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  const resolved: ResolvedGatewayModule[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const modulePath = path.join(dir, entry.name, MODULE_JSON_NAME);
    if (!existsSync(modulePath)) continue;

    try {
      resolved.push(loadGatewayModule(modulePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Gateway] Skip invalid module ${modulePath}: ${message}`);
    }
  }

  return resolved.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function loadGatewayModule(modulePath: string): ResolvedGatewayModule {
  const absoluteModulePath = path.resolve(modulePath);
  const content = readFileSync(absoluteModulePath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  const manifest = parseGatewayManifest(parsed, absoluteModulePath);
  const moduleDir = path.dirname(absoluteModulePath);
  const readmeFile = manifest.docs?.readmeFile ?? DEFAULT_README_FILE;
  const cliDocFile = manifest.docs?.cliDocFile ?? DEFAULT_CLI_DOC_FILE;
  const readmePath = path.join(moduleDir, readmeFile);
  const cliDocPath = path.join(moduleDir, cliDocFile);

  const resolved: ResolvedGatewayModule = {
    manifest,
    modulePath: absoluteModulePath,
    moduleDir,
  };

  if (existsSync(readmePath)) {
    resolved.readmePath = readmePath;
    resolved.readmeExcerpt = excerpt(readFileSync(readmePath, 'utf-8'));
  }
  if (existsSync(cliDocPath)) {
    resolved.cliDocPath = cliDocPath;
    resolved.cliDocExcerpt = excerpt(readFileSync(cliDocPath, 'utf-8'));
  }

  return resolved;
}

export function installGatewayModule(sourcePath: string): ResolvedGatewayModule {
  const absoluteSourcePath = path.resolve(sourcePath);
  const sourceStat = statSync(absoluteSourcePath);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Gateway source must be directory: ${absoluteSourcePath}`);
  }
  const modulePath = path.join(absoluteSourcePath, MODULE_JSON_NAME);
  if (!existsSync(modulePath)) {
    throw new Error(`Missing module.json in ${absoluteSourcePath}`);
  }

  const module = loadGatewayModule(modulePath);
  const targetDir = path.join(ensureGatewayDir(), module.manifest.id);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(absoluteSourcePath, targetDir, { recursive: true });

  const targetModulePath = path.join(targetDir, MODULE_JSON_NAME);
  const installed = loadGatewayModule(targetModulePath);
  ensureGatewayDocs(installed);
  return loadGatewayModule(targetModulePath);
}

export function installGatewayFromCommand(options: {
  id: string;
  name: string;
  version: string;
  description: string;
  command: string;
  args?: string[];
  direction: 'input' | 'output' | 'bidirectional';
  supportedModes: Array<'sync' | 'async'>;
  defaultMode: 'sync' | 'async';
  defaultTarget?: string;
  requestTimeoutMs?: number;
  ackTimeoutMs?: number;
  helpArgs?: string[];
  versionArgs?: string[];
}): ResolvedGatewayModule {
  const moduleDir = path.join(ensureGatewayDir(), options.id);
  rmSync(moduleDir, { recursive: true, force: true });
  mkdirSync(moduleDir, { recursive: true });

  const moduleJsonPath = path.join(moduleDir, MODULE_JSON_NAME);
  const manifest: GatewayModuleManifest = {
    id: options.id,
    name: options.name,
    version: options.version,
    description: options.description,
    direction: options.direction,
    transport: 'process_stdio',
    mode: {
      supported: options.supportedModes,
      default: options.defaultMode,
    },
    process: {
      command: options.command,
      args: options.args ?? [],
      ...(typeof options.requestTimeoutMs === 'number' && Number.isFinite(options.requestTimeoutMs)
        ? { requestTimeoutMs: Math.max(1, Math.floor(options.requestTimeoutMs)) }
        : {}),
      ...(typeof options.ackTimeoutMs === 'number' && Number.isFinite(options.ackTimeoutMs)
        ? { ackTimeoutMs: Math.max(1, Math.floor(options.ackTimeoutMs)) }
        : {}),
      helpArgs: options.helpArgs ?? ['--help'],
      versionArgs: options.versionArgs ?? ['--version'],
    },
    input: options.defaultTarget ? { defaultTarget: options.defaultTarget } : undefined,
    docs: {
      readmeFile: DEFAULT_README_FILE,
      cliDocFile: DEFAULT_CLI_DOC_FILE,
    },
    enabled: true,
  };

  writeFileSync(moduleJsonPath, JSON.stringify(manifest, null, 2), 'utf-8');
  writeFileSync(path.join(moduleDir, DEFAULT_README_FILE), renderReadme(manifest), 'utf-8');
  writeFileSync(path.join(moduleDir, DEFAULT_CLI_DOC_FILE), renderCliDoc(manifest), 'utf-8');
  return loadGatewayModule(moduleJsonPath);
}

export function removeGatewayModule(id: string): boolean {
  const dir = path.join(ensureGatewayDir(), id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function probeGatewayModule(module: ResolvedGatewayModule): GatewayProbeResult {
  const commandAvailable = isCommandAvailable(module.manifest.process.command);
  const helpArgs = module.manifest.process.helpArgs ?? ['--help'];
  const versionArgs = module.manifest.process.versionArgs ?? ['--version'];

  const help = probeCommand(module.manifest.process.command, helpArgs);
  const version = probeCommand(module.manifest.process.command, versionArgs);

  return {
    id: module.manifest.id,
    command: module.manifest.process.command,
    available: commandAvailable,
    help,
    version,
  };
}

function ensureGatewayDocs(module: ResolvedGatewayModule): void {
  const readmePath = module.readmePath ?? path.join(module.moduleDir, DEFAULT_README_FILE);
  const cliDocPath = module.cliDocPath ?? path.join(module.moduleDir, DEFAULT_CLI_DOC_FILE);
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, renderReadme(module.manifest), 'utf-8');
  }
  if (!existsSync(cliDocPath)) {
    writeFileSync(cliDocPath, renderCliDoc(module.manifest), 'utf-8');
  }
}

function renderReadme(manifest: GatewayModuleManifest): string {
  return [
    `# ${manifest.name}`,
    '',
    manifest.description,
    '',
    '## Gateway',
    `- id: \`${manifest.id}\``,
    `- direction: \`${manifest.direction}\``,
    `- mode: \`${manifest.mode.default}\` (supported: ${manifest.mode.supported.join(', ')})`,
    `- command: \`${manifest.process.command} ${(manifest.process.args ?? []).join(' ')}\``,
    '',
  ].join('\n');
}

function renderCliDoc(manifest: GatewayModuleManifest): string {
  return [
    '# CLI Gateway Protocol',
    '',
    `Command: \`${manifest.process.command} ${(manifest.process.args ?? []).join(' ')}\``,
    '',
    'stdin JSONL request:',
    '```json',
    '{"type":"request","requestId":"req-1","deliveryMode":"sync","message":{"text":"hello"}}',
    '```',
    '',
    'stdout JSONL ack/result:',
    '```json',
    '{"type":"ack","requestId":"req-1","accepted":true}',
    '{"type":"result","requestId":"req-1","success":true,"output":{"ok":true}}',
    '```',
    '',
  ].join('\n');
}

function requireProcessConfig(value: unknown, sourcePath: string): GatewayModuleManifest['process'] {
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: process must be object`);
  }
  const command = requireString(value, 'command', sourcePath);
  const args = optionalStringArray(value.args, 'process.args', sourcePath);
  const env = optionalStringMap(value.env, 'process.env', sourcePath);
  const config: GatewayModuleManifest['process'] = {
    command,
  };
  if (args !== undefined) config.args = args;
  const helpArgs = optionalStringArray(value.helpArgs, 'process.helpArgs', sourcePath);
  if (helpArgs !== undefined) config.helpArgs = helpArgs;
  const versionArgs = optionalStringArray(value.versionArgs, 'process.versionArgs', sourcePath);
  if (versionArgs !== undefined) config.versionArgs = versionArgs;
  if (typeof value.cwd === 'string' && value.cwd.trim().length > 0) config.cwd = value.cwd.trim();
  if (env !== undefined) config.env = env;
  if (typeof value.requestTimeoutMs === 'number' && Number.isFinite(value.requestTimeoutMs) && value.requestTimeoutMs > 0) {
    config.requestTimeoutMs = Math.floor(value.requestTimeoutMs);
  }
  if (typeof value.ackTimeoutMs === 'number' && Number.isFinite(value.ackTimeoutMs) && value.ackTimeoutMs > 0) {
    config.ackTimeoutMs = Math.floor(value.ackTimeoutMs);
  }
  return config;
}

function requireMode(value: unknown, sourcePath: string): GatewayModuleManifest['mode'] {
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: mode must be object`);
  }
  const supportedRaw = value.supported;
  if (!Array.isArray(supportedRaw) || supportedRaw.length === 0) {
    throw new Error(`Invalid gateway module at ${sourcePath}: mode.supported must be non-empty array`);
  }
  const supported = supportedRaw.map((item) => requireDeliveryMode(item, sourcePath));
  const uniqueSupported = Array.from(new Set(supported));
  const defaultMode = requireDeliveryMode(value.default, sourcePath);
  if (!uniqueSupported.includes(defaultMode)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: mode.default must be in mode.supported`);
  }
  return { supported: uniqueSupported, default: defaultMode };
}

function requireDirection(value: unknown, sourcePath: string): GatewayModuleManifest['direction'] {
  if (value === 'input' || value === 'output' || value === 'bidirectional') {
    return value;
  }
  throw new Error(`Invalid gateway module at ${sourcePath}: direction must be input|output|bidirectional`);
}

function requireTransport(value: unknown, sourcePath: string): GatewayModuleManifest['transport'] {
  if (value === 'process_stdio') {
    return value;
  }
  throw new Error(`Invalid gateway module at ${sourcePath}: transport must be process_stdio`);
}

function requireDeliveryMode(value: unknown, sourcePath: string): 'sync' | 'async' {
  if (value === 'sync' || value === 'async') return value;
  throw new Error(`Invalid gateway module at ${sourcePath}: delivery mode must be sync|async`);
}

function requireString(record: Record<string, unknown>, field: string, sourcePath: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid gateway module at ${sourcePath}: ${field} must be non-empty string`);
  }
  return value.trim();
}

function optionalStringArray(value: unknown, field: string, sourcePath: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: ${field} must be string[]`);
  }
  const parsed: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`Invalid gateway module at ${sourcePath}: ${field} must be string[]`);
    }
    parsed.push(item);
  }
  return parsed;
}

function optionalStringMap(value: unknown, field: string, sourcePath: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid gateway module at ${sourcePath}: ${field} must be object`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`Invalid gateway module at ${sourcePath}: ${field}.${key} must be string`);
    }
    parsed[key] = entry;
  }
  return parsed;
}

function excerpt(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= DEFAULT_DOC_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, DEFAULT_DOC_EXCERPT_LIMIT)}...`;
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function probeCommand(command: string, args: string[]): { supported: boolean; ok: boolean; exitCode: number | null } {
  if (args.length === 0) {
    return { supported: false, ok: false, exitCode: null };
  }
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return {
    supported: true,
    ok: result.status === 0,
    exitCode: result.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
