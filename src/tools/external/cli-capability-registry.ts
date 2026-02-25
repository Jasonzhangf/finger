import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';

const LEGACY_CAPABILITY_SUFFIX = '.capability.json';
const MODULE_JSON_NAME = 'module.json';
const DEFAULT_README_FILE = 'README.md';
const DEFAULT_CLI_DOC_FILE = 'cli.md';
const DOC_EXCERPT_LIMIT = 1200;

export interface CliCapabilityDescriptor {
  id: string;
  name: string;
  version: string;
  description: string;
  command: string;
  defaultArgs?: string[];
  availabilityCheckArgs?: string[];
  helpArgs?: string[];
  versionArgs?: string[];
  readmeFile?: string;
  cliDocFile?: string;
  enabled?: boolean;
  runtimeDescription?: string;
  docs?: CliCapabilityDocs;
}

export interface CliCapabilityDocs {
  readmePath?: string;
  cliDocPath?: string;
  readmeExcerpt?: string;
  cliDocExcerpt?: string;
}

export interface InstalledCliCapability {
  descriptor: CliCapabilityDescriptor;
  source: 'builtin' | 'file';
  filePath?: string;
}

export interface CliCapabilityProbeResult {
  kind: 'help' | 'version';
  args: string[];
  supported: boolean;
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const BUILTIN_CAPABILITIES: CliCapabilityDescriptor[] = [
  {
    id: 'bd',
    name: 'BD Task CLI',
    version: '1.0.0',
    description: '任务管理 CLI 能力（动态检测系统是否安装 bd）',
    command: 'bd',
    defaultArgs: [],
    availabilityCheckArgs: ['--version'],
    helpArgs: ['--help'],
    versionArgs: ['--version'],
    enabled: true,
  },
];

export function resolveCliCapabilityDir(): string {
  return process.env.FINGER_CLI_TOOL_CAPABILITY_DIR || path.join(homedir(), '.finger', 'capabilities', 'tools');
}

export function ensureCliCapabilityDir(): string {
  const dir = resolveCliCapabilityDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function parseCliCapabilityDescriptor(value: unknown, sourcePath: string): CliCapabilityDescriptor {
  if (!isRecord(value)) {
    throw new Error(`Invalid capability descriptor at ${sourcePath}: expected object`);
  }

  const descriptor: CliCapabilityDescriptor = {
    id: requireString(value, 'id', sourcePath),
    name: requireString(value, 'name', sourcePath),
    version: requireString(value, 'version', sourcePath),
    description: requireString(value, 'description', sourcePath),
    command: requireString(value, 'command', sourcePath),
  };

  const defaultArgs = parseStringArray(value.defaultArgs);
  if (defaultArgs !== undefined) descriptor.defaultArgs = defaultArgs;

  const availabilityCheckArgs = parseStringArray(value.availabilityCheckArgs);
  if (availabilityCheckArgs !== undefined) descriptor.availabilityCheckArgs = availabilityCheckArgs;

  const helpArgs = parseStringArray(value.helpArgs);
  if (helpArgs !== undefined) descriptor.helpArgs = helpArgs;

  const versionArgs = parseStringArray(value.versionArgs);
  if (versionArgs !== undefined) descriptor.versionArgs = versionArgs;

  if (typeof value.readmeFile === 'string' && value.readmeFile.trim().length > 0) {
    descriptor.readmeFile = value.readmeFile.trim();
  }
  if (typeof value.cliDocFile === 'string' && value.cliDocFile.trim().length > 0) {
    descriptor.cliDocFile = value.cliDocFile.trim();
  }

  if (typeof value.enabled === 'boolean') {
    descriptor.enabled = value.enabled;
  }

  return descriptor;
}

export function listInstalledCliCapabilities(): InstalledCliCapability[] {
  const capabilityMap = new Map<string, InstalledCliCapability>();

  for (const builtin of BUILTIN_CAPABILITIES) {
    capabilityMap.set(builtin.id, {
      descriptor: buildDescriptorWithDocs(builtin),
      source: 'builtin',
    });
  }

  const dir = ensureCliCapabilityDir();
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const modulePath = path.join(dir, entry.name, MODULE_JSON_NAME);
      if (!existsSync(modulePath)) continue;
      loadCapabilityDescriptorFromFile(modulePath, capabilityMap, true);
      continue;
    }
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(LEGACY_CAPABILITY_SUFFIX)) {
      continue;
    }
    const legacyPath = path.join(dir, entry.name);
    loadCapabilityDescriptorFromFile(legacyPath, capabilityMap, false);
  }

  return Array.from(capabilityMap.values()).sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
}

export function installCliCapabilityDescriptor(sourcePath: string): InstalledCliCapability {
  const resolvedSource = path.resolve(sourcePath);
  const sourceStat = statSync(resolvedSource);

  if (sourceStat.isDirectory()) {
    const sourceModulePath = path.join(resolvedSource, MODULE_JSON_NAME);
    if (!existsSync(sourceModulePath)) {
      throw new Error(`Capability directory missing ${MODULE_JSON_NAME}: ${resolvedSource}`);
    }
    const content = readFileSync(sourceModulePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const descriptor = parseCliCapabilityDescriptor(parsed, sourceModulePath);

    const installedDir = path.join(ensureCliCapabilityDir(), descriptor.id);
    rmSync(installedDir, { recursive: true, force: true });
    mkdirSync(installedDir, { recursive: true });
    cpSync(resolvedSource, installedDir, { recursive: true });

    const modulePath = path.join(installedDir, MODULE_JSON_NAME);
    const hydrated = buildDescriptorWithDocs(descriptor, modulePath);
    return {
      descriptor: hydrated,
      source: 'file',
      filePath: modulePath,
    };
  }

  const content = readFileSync(resolvedSource, 'utf-8');
  const descriptor = parseCliCapabilityDescriptor(JSON.parse(content) as unknown, resolvedSource);
  return installCapabilityIntoDirectory(descriptor);
}

export function installCliCapabilityFromCommand(
  id: string,
  name: string,
  command: string,
  description: string,
  version = '1.0.0',
  defaultArgs: string[] = [],
  options: {
    helpArgs?: string[];
    versionArgs?: string[];
    readmeFile?: string;
    cliDocFile?: string;
  } = {},
): InstalledCliCapability {
  const descriptor: CliCapabilityDescriptor = {
    id,
    name,
    version,
    command,
    description,
    defaultArgs,
    helpArgs: options.helpArgs ?? ['help'],
    versionArgs: options.versionArgs ?? ['--version'],
    readmeFile: options.readmeFile ?? DEFAULT_README_FILE,
    cliDocFile: options.cliDocFile ?? DEFAULT_CLI_DOC_FILE,
    enabled: true,
  };
  return installCapabilityIntoDirectory(descriptor);
}

export function removeCliCapabilityDescriptor(id: string): boolean {
  const baseDir = ensureCliCapabilityDir();
  const legacyPath = path.join(baseDir, `${id}${LEGACY_CAPABILITY_SUFFIX}`);
  const moduleDirPath = path.join(baseDir, id);

  let removed = false;
  if (existsSync(legacyPath)) {
    rmSync(legacyPath, { force: true });
    removed = true;
  }
  if (existsSync(moduleDirPath)) {
    rmSync(moduleDirPath, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

export function isCliCommandAvailable(command: string): boolean {
  const whichResult = spawnSync('which', [command], { stdio: 'ignore' });
  return whichResult.status === 0;
}

export function resolveAvailableCliCapabilities(): CliCapabilityDescriptor[] {
  const installed = listInstalledCliCapabilities();
  return installed
    .map((item) => item.descriptor)
    .filter((capability) => capability.enabled !== false)
    .filter((capability) => isCliCommandAvailable(capability.command));
}

export function probeCliCapability(descriptor: CliCapabilityDescriptor, kind: 'help' | 'version'): CliCapabilityProbeResult {
  const args = kind === 'help' ? (descriptor.helpArgs ?? ['help']) : (descriptor.versionArgs ?? ['--version']);
  if (args.length === 0) {
    return {
      kind,
      args,
      supported: false,
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '',
    };
  }

  const result = spawnSync(descriptor.command, args, {
    encoding: 'utf-8',
    shell: false,
  });

  return {
    kind,
    args,
    supported: true,
    ok: result.status === 0,
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function buildCapabilityRuntimeDescription(descriptor: CliCapabilityDescriptor): string {
  const helpArgs = formatProbeArgs(descriptor.helpArgs ?? ['help']);
  const versionArgs = formatProbeArgs(descriptor.versionArgs ?? ['--version']);
  const lines: string[] = [];

  lines.push(`L1/基础功能: ${descriptor.description}`);
  lines.push(`L1/命令入口: ${descriptor.command}`);
  lines.push(`L2/快速探测: ${descriptor.command} ${helpArgs}`);
  lines.push(`L2/版本探测: ${descriptor.command} ${versionArgs}`);

  const readmePath = descriptor.docs?.readmePath;
  const cliDocPath = descriptor.docs?.cliDocPath;
  lines.push(`L3/详细文档: README=${readmePath ?? '未提供'} | CLI=${cliDocPath ?? '未提供'}`);

  if (descriptor.docs?.readmeExcerpt) {
    lines.push(`README 摘要:\n${descriptor.docs.readmeExcerpt}`);
  }
  if (descriptor.docs?.cliDocExcerpt) {
    lines.push(`cli.md 摘要:\n${descriptor.docs.cliDocExcerpt}`);
  }

  return lines.join('\n');
}

function installCapabilityIntoDirectory(descriptor: CliCapabilityDescriptor): InstalledCliCapability {
  const baseDir = ensureCliCapabilityDir();
  const moduleDir = path.join(baseDir, descriptor.id);
  const legacyPath = path.join(baseDir, `${descriptor.id}${LEGACY_CAPABILITY_SUFFIX}`);
  rmSync(legacyPath, { force: true });
  rmSync(moduleDir, { recursive: true, force: true });
  mkdirSync(moduleDir, { recursive: true });

  const modulePath = path.join(moduleDir, MODULE_JSON_NAME);
  const normalized = normalizeDescriptorForStorage(descriptor);
  writeFileSync(modulePath, JSON.stringify(normalized, null, 2), 'utf-8');

  const readmePath = path.join(moduleDir, normalized.readmeFile ?? DEFAULT_README_FILE);
  const cliDocPath = path.join(moduleDir, normalized.cliDocFile ?? DEFAULT_CLI_DOC_FILE);

  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, renderCapabilityReadme(normalized), 'utf-8');
  }
  if (!existsSync(cliDocPath)) {
    writeFileSync(cliDocPath, renderCapabilityCliDoc(normalized), 'utf-8');
  }

  const hydrated = buildDescriptorWithDocs(normalized, modulePath);
  return {
    descriptor: hydrated,
    source: 'file',
    filePath: modulePath,
  };
}

function loadCapabilityDescriptorFromFile(
  filePath: string,
  capabilityMap: Map<string, InstalledCliCapability>,
  preferOverride: boolean,
): void {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const descriptor = parseCliCapabilityDescriptor(parsed, filePath);
    const existing = capabilityMap.get(descriptor.id);
    if (existing && !preferOverride) {
      return;
    }
    capabilityMap.set(descriptor.id, {
      descriptor: buildDescriptorWithDocs(descriptor, filePath),
      source: 'file',
      filePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Capability] Skip invalid descriptor ${filePath}: ${message}`);
  }
}

function buildDescriptorWithDocs(
  descriptor: CliCapabilityDescriptor,
  descriptorFilePath?: string,
): CliCapabilityDescriptor {
  const docs = resolveCapabilityDocs(descriptor, descriptorFilePath);
  const normalized = {
    ...descriptor,
    defaultArgs: descriptor.defaultArgs ?? [],
    helpArgs: descriptor.helpArgs ?? ['help'],
    versionArgs: descriptor.versionArgs ?? ['--version'],
    readmeFile: descriptor.readmeFile ?? DEFAULT_README_FILE,
    cliDocFile: descriptor.cliDocFile ?? DEFAULT_CLI_DOC_FILE,
    docs,
  };

  normalized.runtimeDescription = buildCapabilityRuntimeDescription(normalized);
  return normalized;
}

function normalizeDescriptorForStorage(descriptor: CliCapabilityDescriptor): CliCapabilityDescriptor {
  return {
    ...descriptor,
    defaultArgs: descriptor.defaultArgs ?? [],
    helpArgs: descriptor.helpArgs ?? ['help'],
    versionArgs: descriptor.versionArgs ?? ['--version'],
    readmeFile: descriptor.readmeFile ?? DEFAULT_README_FILE,
    cliDocFile: descriptor.cliDocFile ?? DEFAULT_CLI_DOC_FILE,
  };
}

function resolveCapabilityDocs(descriptor: CliCapabilityDescriptor, descriptorFilePath?: string): CliCapabilityDocs {
  if (!descriptorFilePath) return {};

  const moduleDir = path.dirname(descriptorFilePath);
  const readmePath = path.join(moduleDir, descriptor.readmeFile ?? DEFAULT_README_FILE);
  const cliDocPath = path.join(moduleDir, descriptor.cliDocFile ?? DEFAULT_CLI_DOC_FILE);
  const docs: CliCapabilityDocs = {};

  if (existsSync(readmePath)) {
    docs.readmePath = readmePath;
    docs.readmeExcerpt = extractTextExcerpt(readFileSync(readmePath, 'utf-8'));
  }
  if (existsSync(cliDocPath)) {
    docs.cliDocPath = cliDocPath;
    docs.cliDocExcerpt = extractTextExcerpt(readFileSync(cliDocPath, 'utf-8'));
  }

  return docs;
}

function extractTextExcerpt(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= DOC_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, DOC_EXCERPT_LIMIT)}...`;
}

function renderCapabilityReadme(descriptor: CliCapabilityDescriptor): string {
  const helpArgs = formatProbeArgs(descriptor.helpArgs ?? ['help']);
  const versionArgs = formatProbeArgs(descriptor.versionArgs ?? ['--version']);
  return [
    `# ${descriptor.name}`,
    '',
    descriptor.description,
    '',
    '## 功能概述',
    `- CLI 命令: \`${descriptor.command}\``,
    `- 能力 ID: \`${descriptor.id}\``,
    '',
    '## 快速开始',
    `1. \`${descriptor.command} ${helpArgs}\``,
    `2. \`${descriptor.command} ${versionArgs}\``,
    '',
    '## 进阶文档',
    `详见 \`${descriptor.cliDocFile ?? DEFAULT_CLI_DOC_FILE}\`。`,
    '',
  ].join('\n');
}

function renderCapabilityCliDoc(descriptor: CliCapabilityDescriptor): string {
  const helpArgs = formatProbeArgs(descriptor.helpArgs ?? ['help']);
  const versionArgs = formatProbeArgs(descriptor.versionArgs ?? ['--version']);
  return [
    '# CLI 命令集',
    '',
    `命令入口：\`${descriptor.command}\``,
    '',
    '## 可用探测命令',
    `- help: \`${descriptor.command} ${helpArgs}\``,
    `- version: \`${descriptor.command} ${versionArgs}\``,
    '',
    '## AI 调用建议',
    '- 先运行 help 获取命令面。',
    '- 再运行 version 确认版本。',
    '- 最后根据任务拼装实际执行参数。',
    '',
  ].join('\n');
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
  if (parsed.some((item) => item.length === 0)) {
    throw new Error('string[] field contains empty string');
  }
  return parsed;
}

function formatProbeArgs(args: string[]): string {
  if (args.length === 0) return '(disabled)';
  return args.join(' ');
}

function requireString(record: Record<string, unknown>, field: string, sourcePath: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid capability descriptor at ${sourcePath}: field "${field}" must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
