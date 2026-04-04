import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const makeTempHome = () => mkdtempSync(path.join(tmpdir(), 'finger-ai-config-'));

describe('AIProviderConfig', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = makeTempHome();
    process.env.FINGER_HOME = tempHome;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.FINGER_HOME;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('passes when user-settings is missing (bootstrap defaults)', async () => {
    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).resolves.toBeUndefined();
  });

  it('passes when valid user-settings is present', async () => {
    const { loadUserSettings, saveUserSettings } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    settings.aiProviders.default = 'tcm';
    settings.aiProviders.providers.tcm = {
      name: 'tcm',
      base_url: 'http://127.0.0.1:5555/v1',
      wire_api: 'responses',
      env_key: 'ROUTECODEX_HTTP_APIKEY',
      model: 'gpt-5.4',
      enabled: true,
    };
    saveUserSettings(settings);

    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).resolves.toBeUndefined();
  });

  it('throws when provider config is invalid in user-settings', async () => {
    const { loadUserSettings, saveUserSettings } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    settings.aiProviders.providers.tcm = {
      ...settings.aiProviders.providers.tcm,
      base_url: 'not-a-valid-url',
    };
    saveUserSettings(settings);

    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).rejects.toThrow('Invalid AI provider config in user-settings.json');
  });
});
