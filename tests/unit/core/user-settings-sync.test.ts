import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const makeTempHome = () => mkdtempSync(path.join(tmpdir(), 'finger-user-settings-sync-'));

describe('UserSettingsSync', () => {
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

  it('syncs user settings into config.json kernel section', async () => {
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
        thinkingEnabled: true,
        webSearch: 'live',
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };

    writeFileSync(userSettingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { syncUserSettingsToKernelConfig } = await import('../../../src/core/user-settings-sync.js');
    const config = syncUserSettingsToKernelConfig();

    expect(config.kernel?.provider).toBe('tcm');
    expect(config.kernel?.providers?.tcm).toBeDefined();
  });

  it('preserves existing config fields while updating kernel', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');
    const existingConfig = {
      channelAuth: { enabled: true },
      kernel: { provider: 'old', providers: { old: { name: 'old' } } },
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');

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
        thinkingEnabled: true,
        webSearch: 'live',
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };
    writeFileSync(userSettingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { syncUserSettingsToKernelConfig } = await import('../../../src/core/user-settings-sync.js');
    const config = syncUserSettingsToKernelConfig();

    expect(config.channelAuth).toEqual({ enabled: true });
    expect(config.kernel?.provider).toBe('tcm');
    expect(config.kernel?.providers?.tcm).toBeDefined();
  });

  it('writes merged config to disk', async () => {
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
        thinkingEnabled: true,
        webSearch: 'live',
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };
    writeFileSync(userSettingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { syncUserSettingsToKernelConfig } = await import('../../../src/core/user-settings-sync.js');
    syncUserSettingsToKernelConfig();

    const configPath = path.join(configDir, 'config.json');
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);

    expect(config.kernel.provider).toBe('tcm');
    expect(config.kernel.providers.tcm).toBeDefined();
  });

  it('preserves kernel extra fields and is idempotent', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');
    const existingConfig = {
      channelAuth: { enabled: true },
      kernel: {
        provider: 'old',
        providers: { old: { name: 'old' } },
        extra: { foo: 'bar' },
      },
      extraTopLevel: { keep: true },
    };
    writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');

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
        thinkingEnabled: true,
        webSearch: 'live',
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };
    writeFileSync(userSettingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { syncUserSettingsToKernelConfig } = await import('../../../src/core/user-settings-sync.js');
    syncUserSettingsToKernelConfig();

    const first = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(first.kernel.provider).toBe('tcm');
    expect(first.kernel.providers.tcm).toBeDefined();
    expect(first.kernel.extra).toEqual({ foo: 'bar' });
    expect(first.extraTopLevel).toEqual({ keep: true });

    syncUserSettingsToKernelConfig();
    const second = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(second).toEqual(first);
  });
});
