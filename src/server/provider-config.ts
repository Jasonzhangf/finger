import { loadUserSettings, saveUserSettings, type AIProvider } from '../core/user-settings.js';

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

export interface UpsertProviderInput {
  id: string;
  name?: string;
  baseUrl?: string;
  wireApi?: string;
  envKey?: string;
  model?: string;
  select?: boolean;
}

export function listKernelProviders(): ProviderConfigRecord[] {
  const settings = loadUserSettings();
  const active = (settings.aiProviders.default || '').trim();
  const providers = settings.aiProviders.providers || {};
  const result: ProviderConfigRecord[] = [];
  for (const [id, provider] of Object.entries(providers)) {
    const typedProvider = provider as AIProvider;
    const baseUrl = typedProvider.base_url?.trim() || '';
    const wireApi = typedProvider.wire_api?.trim() || 'responses';
    const envKey = typedProvider.env_key?.trim() || '';
    const model = typedProvider.model?.trim() || '';
    const record: ProviderConfigRecord = {
      id,
      name: typedProvider.name?.trim() || id,
      type: 'custom',
      baseUrl,
      wireApi,
      envKey,
      model,
      defaultModel: model,
      isActive: id === active,
      status: id === active && typedProvider.enabled !== false ? 'connected' : 'disconnected',
    };
    result.push(record);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveActiveKernelProviderId(): string {
  const settings = loadUserSettings();
  const active = (settings.aiProviders.default || '').trim();
  if (active.length > 0) return active;
  const first = Object.keys(settings.aiProviders.providers || {})[0];
  return typeof first === 'string' ? first : '';
}

export function selectKernelProvider(providerId: string): ProviderConfigRecord {
  const normalized = providerId.trim();
  if (!normalized) {
    throw new Error('providerId is required');
  }
  const settings = loadUserSettings();
  if (!settings.aiProviders.providers?.[normalized]) {
    throw new Error(`provider '${normalized}' is not configured`);
  }
  settings.aiProviders.default = normalized;
  settings.updated_at = new Date().toISOString();
  saveUserSettings(settings);

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

  const settings = loadUserSettings();
  const existing = settings.aiProviders.providers?.[id];
  const next: AIProvider = {
    name: input.name?.trim() || existing?.name || id,
    base_url: input.baseUrl?.trim() || existing?.base_url || '',
    wire_api: (input.wireApi?.trim() as AIProvider['wire_api']) || existing?.wire_api || 'responses',
    env_key: input.envKey?.trim() || existing?.env_key || '',
    model: input.model?.trim() || existing?.model || '',
    enabled: existing?.enabled ?? true,
  };

  if (!next.base_url) throw new Error(`provider '${id}' requires baseUrl`);
  if (!next.env_key) throw new Error(`provider '${id}' requires envKey`);
  if (!next.model) throw new Error(`provider '${id}' requires model`);

  settings.aiProviders.providers[id] = next;
  if (input.select === true) {
    settings.aiProviders.default = id;
  }
  settings.updated_at = new Date().toISOString();
  saveUserSettings(settings);

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
