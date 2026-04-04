import { loadAIProviders } from './user-settings.js';

export interface KernelProviderConfig {
  id: string;
  name?: string;
  base_url: string;
  wire_api: 'responses' | 'http';
  env_key: string;
  model: string;
  enabled?: boolean;
}

export function resolveKernelProvider(providerId?: string): {
  provider?: KernelProviderConfig;
  reason?: string;
} {
  try {
    const aiProviders = loadAIProviders();
    const providers = aiProviders?.providers;
    if (!providers || typeof providers !== 'object') {
      return { reason: 'providers_missing' };
    }
    const selectedId = (providerId || aiProviders.default || '').trim();
    if (!selectedId) return { reason: 'provider_id_missing' };
    const found = providers[selectedId];
    if (!found || typeof found !== 'object') {
      return { reason: 'provider_not_found' };
    }
    if (typeof found.enabled === 'boolean' && found.enabled === false) {
      return { reason: 'provider_disabled' };
    }
    const baseUrl = typeof found.base_url === 'string' ? found.base_url.trim() : '';
    const envKey = typeof found.env_key === 'string' ? found.env_key.trim() : '';
    const model = typeof found.model === 'string' ? found.model.trim() : '';
    const wireApiRaw = typeof found.wire_api === 'string' ? found.wire_api.trim() : '';
    const wireApi = wireApiRaw === 'http' ? 'http' : 'responses';
    if (!baseUrl) return { reason: 'provider_base_url_missing' };
    if (!model) return { reason: 'provider_model_missing' };
    if (!envKey) return { reason: 'provider_env_key_missing' };
    return {
      provider: {
        id: selectedId,
        ...(typeof found.name === 'string' && found.name.trim().length > 0
          ? { name: found.name.trim() }
          : {}),
        base_url: baseUrl,
        wire_api: wireApi,
        env_key: envKey,
        model,
        ...(typeof found.enabled === 'boolean' ? { enabled: found.enabled } : {}),
      },
    };
  } catch {
    return { reason: 'user_settings_error' };
  }
}

export function buildResponsesEndpoints(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return [];
  const endpoints: string[] = [];
  if (/\/v1$/i.test(trimmed)) {
    endpoints.push(`${trimmed}/responses`);
    endpoints.push(`${trimmed.replace(/\/v1$/i, '')}/responses`);
  } else {
    endpoints.push(`${trimmed}/v1/responses`);
    endpoints.push(`${trimmed}/responses`);
  }
  return endpoints.filter((item, index, arr) => arr.indexOf(item) === index);
}

export function buildProviderHeaders(provider: KernelProviderConfig): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const envKey = provider.env_key?.trim();
  if (envKey) {
    const apiKey = process.env[envKey];
    if (typeof apiKey === 'string' && apiKey.trim().length > 0) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }
  }
  return headers;
}
