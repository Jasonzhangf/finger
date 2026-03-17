import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const makeTempHome = () => mkdtempSync(path.join(tmpdir(), 'finger-user-settings-integration-'));

describe('UserSettingsSync + AIProviderConfig integration', () => {
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

  it('syncs user settings, writes config.json, and passes provider config check', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });

    const userSettingsPath = path.join(configDir, 'user-settings.json');
    const payload = {
      version: '1.0',
      updated_at: new Date().toISOString(),
      aiProviders: {
        default: 'tcm',
        providers: {
          tcm: {
            name: 'tcm',
            base_url: 'http://127.0.0.1:5555/v1',
            wire_api: 'responses',
            env_key: 'ROUTECODEX_HTTP_APIKEY',
            model: 'gpt-5.4',
            enabled: true,
          },
        },
      },
      preferences: {
        defaultModel: 'gpt-5.4',
        maxTokens: 256000,
        temperature: 0.7,
        reasoningEffort: 'high',
        reasoningSummary: 'detailed',
        verbosity: 'medium',
        showRawAgentReasoning: false,
        webSearch: 'live',
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };

    writeFileSync(userSettingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { syncUserSettingsToKernelConfig } = await import('../../src/core/user-settings-sync.js');
    syncUserSettingsToKernelConfig();

    const configPath = path.join(configDir, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.kernel.provider).toBe('tcm');
    expect(config.kernel.providers.tcm).toBeDefined();
    expect(config.kernel.providers.tcm.base_url).toBe('http://127.0.0.1:5555/v1');

    const { checkAIProviderConfig } = await import('../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).resolves.toBeUndefined();
  });
});
