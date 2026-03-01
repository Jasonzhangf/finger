import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { FINGER_PATHS, ensureDir } from '../core/finger-paths.js';

const CONFIG_PATH = FINGER_PATHS.config.file.main;
const DEFAULT_BASE_URL = 'https://codex.funai.vip/openai';
const DEFAULT_WIRE_API = 'responses';

export interface ProviderConfigRecord {
  id: string;
  name: string;
  type: 'custom';
  baseUrl: string;
  wireApi: string;
  envKey: string;
  model: string;
  defaultModel: string;
  isActive: boolean;
  status: 'connected' | 'disconnected' | 'error';
}

interface KernelProviderJson {
  name?: string;
  base_url?: string;
  wire_api?: string;
  env_key?: string;
  model?: string;
}

interface KernelConfigJson {
  provider?: string;
  providers?: Record<string, KernelProviderJson>;
}

interface FingerConfigJson {
  kernel?: KernelConfigJson;
}

export interface UpsertProviderInput {
  id: string;
  name?: string;
  baseUrl?: string;
  wireApi?: string;
  envKey?: string;
  model?: string;
  select?: boolean;
}

const DEFAULT_PROVIDERS: Record<string, Required<KernelProviderJson>> = {
  crsa: {
    name: 'crsa',
    base_url: DEFAULT_BASE_URL,
    wire_api: DEFAULT_WIRE_API,
    env_key: 'CRS_OAI_KEY1',
    model: 'gpt-5.3-codex',
  },
  crsb: {
    name: 'crsb',
    base_url: DEFAULT_BASE_URL,
    wire_api: DEFAULT_WIRE_API,
    env_key: 'CRS_OAI_KEY2',
    model: 'gpt-5.3-codex',
  },
  'routecodex-5520': {
    name: 'routecodex-local-5520',
    base_url: 'http://127.0.0.1:5520',
    wire_api: DEFAULT_WIRE_API,
    env_key: 'CRS_OAI_KEY2',
    model: 'gpt-5.3-codex',
  },
};

function ensureFingerHomeDir(): void {
  ensureDir(FINGER_PATHS.config.dir);
}

function readConfigFile(): FingerConfigJson {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as FingerConfigJson;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfigFile(config: FingerConfigJson): void {
  ensureFingerHomeDir();
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

function toKernelProviderJson(input: UpsertProviderInput, fallback: KernelProviderJson): KernelProviderJson {
  return {
    name: input.name?.trim() || fallback.name || input.id,
    base_url: input.baseUrl?.trim() || fallback.base_url || DEFAULT_BASE_URL,
    wire_api: input.wireApi?.trim() || fallback.wire_api || DEFAULT_WIRE_API,
    env_key: input.envKey?.trim() || fallback.env_key || 'CRS_OAI_KEY2',
    model: input.model?.trim() || fallback.model || 'gpt-5.3-codex',
  };
}

function ensureKernelConfig(config: FingerConfigJson): Required<Pick<FingerConfigJson, 'kernel'>>['kernel'] {
  if (!config.kernel || typeof config.kernel !== 'object') {
    config.kernel = {};
  }
  if (!config.kernel.providers || typeof config.kernel.providers !== 'object') {
    config.kernel.providers = {};
  }
  for (const [id, defaults] of Object.entries(DEFAULT_PROVIDERS)) {
    const existing = config.kernel.providers[id];
    config.kernel.providers[id] = {
      name: existing?.name || defaults.name,
      base_url: existing?.base_url || defaults.base_url,
      wire_api: existing?.wire_api || defaults.wire_api,
      env_key: existing?.env_key || defaults.env_key,
      model: existing?.model || defaults.model,
    };
  }
  if (!config.kernel.provider || config.kernel.provider.trim().length === 0) {
    config.kernel.provider = 'crsb';
  }
  return config.kernel;
}

export function listKernelProviders(): ProviderConfigRecord[] {
  const config = readConfigFile();
  const kernel = ensureKernelConfig(config);
  const active = (kernel.provider || 'crsb').trim();
  const providers = kernel.providers || {};
  const result: ProviderConfigRecord[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    const baseUrl = provider.base_url?.trim() || DEFAULT_BASE_URL;
    const record: ProviderConfigRecord = {
      id,
      name: provider.name?.trim() || id,
      type: 'custom',
      baseUrl,
      wireApi: provider.wire_api?.trim() || DEFAULT_WIRE_API,
      envKey: provider.env_key?.trim() || 'CRS_OAI_KEY2',
      model: provider.model?.trim() || 'gpt-5.3-codex',
      defaultModel: provider.model?.trim() || 'gpt-5.3-codex',
      isActive: id === active,
      status: id === active ? 'connected' : 'disconnected',
    };
    result.push(record);
  }
  writeConfigFile(config);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveActiveKernelProviderId(): string {
  const config = readConfigFile();
  const kernel = ensureKernelConfig(config);
  writeConfigFile(config);
  const active = (kernel.provider || 'crsb').trim();
  return active.length > 0 ? active : 'crsb';
}

export function selectKernelProvider(providerId: string): ProviderConfigRecord {
  const normalized = providerId.trim();
  if (!normalized) {
    throw new Error('providerId is required');
  }
  const config = readConfigFile();
  const kernel = ensureKernelConfig(config);
  if (!kernel.providers?.[normalized]) {
    throw new Error(`provider '${normalized}' is not configured`);
  }
  kernel.provider = normalized;
  writeConfigFile(config);
  const selected = listKernelProviders().find((item) => item.id === normalized);
  if (!selected) {
    throw new Error(`provider '${normalized}' is not available`);
  }
  return selected;
}

export function upsertKernelProvider(input: UpsertProviderInput): ProviderConfigRecord {
  const id = input.id.trim();
  if (!id) {
    throw new Error('provider id is required');
  }
  const config = readConfigFile();
  const kernel = ensureKernelConfig(config);
  const existing = kernel.providers?.[id] ?? {};
  const next = toKernelProviderJson(input, existing);
  kernel.providers![id] = next;
  if (input.select === true) {
    kernel.provider = id;
  }
  writeConfigFile(config);
  const selected = listKernelProviders().find((item) => item.id === id);
  if (!selected) {
    throw new Error(`provider '${id}' upsert failed`);
  }
  return selected;
}

export async function testKernelProvider(providerId: string): Promise<{ success: boolean; message: string }> {
  const normalized = providerId.trim();
  if (!normalized) {
    throw new Error('providerId is required');
  }
  const provider = listKernelProviders().find((item) => item.id === normalized);
  if (!provider) {
    throw new Error(`provider '${normalized}' is not configured`);
  }

  const base = provider.baseUrl.replace(/\/+$/, '');
  const timeoutMs = 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthResp = await fetch(`${base}/health`, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (healthResp.ok) {
      return { success: true, message: `health ok (${healthResp.status})` };
    }
    return { success: false, message: `health status ${healthResp.status}` };
  } catch (error) {
    clearTimeout(timer);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `unreachable: ${message}` };
  }
}
