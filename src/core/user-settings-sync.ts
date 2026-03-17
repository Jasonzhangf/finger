/**
 * User Settings Sync
 *
 * Syncs user-settings.json into config.json (kernel section).
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir } from './finger-paths.js';
import { loadUserSettings } from './user-settings.js';
import { logger } from './logger.js';

const log = logger.module('UserSettingsSync');

export interface FingerKernelConfig {
  provider?: string;
  providers?: Record<string, unknown>;
}

export interface FingerConfigFile {
  kernel?: FingerKernelConfig;
  [key: string]: unknown;
}

export function normalizeKernelProviderBaseUrl(baseUrl: string, wireApi: unknown): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return trimmed;
  if (wireApi !== 'responses') return trimmed;
  return trimmed.replace(/\/v1\/?$/i, '');
}

export function syncUserSettingsToKernelConfig(): FingerConfigFile {
  const userSettings = loadUserSettings();
  const configPath = path.join(FINGER_PATHS.config.dir, 'config.json');

  let config: FingerConfigFile = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as FingerConfigFile;
    } catch (error) {
      log.error('[UserSettingsSync] Failed to parse existing config.json, overwriting',
        error instanceof Error ? error : new Error(String(error)));
      config = {};
    }
  }

  const kernelProviders = Object.fromEntries(
    Object.entries(userSettings.aiProviders.providers).map(([providerId, provider]) => [
      providerId,
      {
        ...provider,
        base_url: normalizeKernelProviderBaseUrl(provider.base_url, provider.wire_api),
      },
    ]),
  );
  const defaultProvider = userSettings.aiProviders.default;

  const nextConfig: FingerConfigFile = {
    ...config,
    kernel: {
      ...(config.kernel ?? {}),
      providers: kernelProviders,
      provider: defaultProvider,
    },
  };

  ensureDir(FINGER_PATHS.config.dir);
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), 'utf-8');

  log.info('[UserSettingsSync] Synced user settings to config.json', {
    defaultProvider,
    providerCount: Object.keys(kernelProviders).length,
  });

  return nextConfig;
}
