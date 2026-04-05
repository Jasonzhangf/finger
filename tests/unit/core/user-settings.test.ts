import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const makeTempHome = () => mkdtempSync(path.join(tmpdir(), 'finger-user-settings-'));

describe('UserSettings', () => {
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

  it('returns defaults when settings file is missing', async () => {
    const { loadUserSettings, resolveAutonomyModeForRole } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    expect(settings.aiProviders.default).toBe('tcm');
    expect(settings.preferences.defaultModel).toBe('tabglm.glm-5-turbo');
    expect(resolveAutonomyModeForRole(settings.preferences, 'system')).toBe('balanced');
    expect(resolveAutonomyModeForRole(settings.preferences, 'project')).toBe('yolo');
  });

  it('saves and reloads user settings', async () => {
    const { loadUserSettings, saveUserSettings, getUserSettingsPath } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    settings.preferences.temperature = 0.5;
    saveUserSettings(settings);

    const settingsPath = getUserSettingsPath();
    expect(existsSync(settingsPath)).toBe(true);

    const reloaded = loadUserSettings();
    expect(reloaded.preferences.temperature).toBe(0.5);
  });

  it('validates missing default provider', async () => {
    const { validateUserSettings } = await import('../../../src/core/user-settings.js');
    expect(() => validateUserSettings({ aiProviders: { providers: {} } })).toThrow('default');
  });

  it('updates default provider', async () => {
    const { loadUserSettings, saveUserSettings, setDefaultAIProvider } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();

    settings.aiProviders.providers.rcm = {
      name: 'rcm',
      base_url: 'http://127.0.0.1:5520/v1',
      wire_api: 'responses',
      env_key: 'ROUTECODEX_HTTP_APIKEY',
      model: 'gpt-5.4',
      enabled: true,
    };
    saveUserSettings(settings);

    setDefaultAIProvider('rcm');
    const updated = loadUserSettings();
    expect(updated.aiProviders.default).toBe('rcm');
  });

  it('loads settings from disk when file exists', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const settingsPath = path.join(configDir, 'user-settings.json');
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
        autonomyMode: 'balanced',
        autonomyByRole: {
          system: 'balanced',
          project: 'yolo',
        },
      },
      ui: {
        theme: 'dark',
        language: 'zh-CN',
        timeZone: 'Asia/Shanghai',
      },
    };

    writeFileSync(settingsPath, JSON.stringify(payload, null, 2), 'utf-8');

    const { loadUserSettings, resolveAutonomyModeForRole } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    expect(settings.aiProviders.default).toBe('tcm');
    expect(resolveAutonomyModeForRole(settings.preferences, 'project')).toBe('yolo');
    expect(resolveAutonomyModeForRole(settings.preferences, 'reviewer')).toBe('balanced');
  });

  it('falls back to global autonomy mode for unknown role', async () => {
    const { loadUserSettings, saveUserSettings, resolveAutonomyModeForRole } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    settings.preferences.autonomyMode = 'yolo';
    settings.preferences.autonomyByRole = {
      system: 'balanced',
      project: 'yolo',
      reviewer: 'balanced',
    };
    saveUserSettings(settings);
    const reloaded = loadUserSettings();
    expect(resolveAutonomyModeForRole(reloaded.preferences, 'unknown')).toBe('yolo');
    expect(resolveAutonomyModeForRole(reloaded.preferences, 'system')).toBe('balanced');
  });

  it('prefers provider config from config.json over user-settings.json', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const settingsPath = path.join(configDir, 'user-settings.json');
    const configPath = path.join(configDir, 'config.json');

    writeFileSync(settingsPath, JSON.stringify({
      version: '1.0',
      updated_at: new Date().toISOString(),
      aiProviders: {
        default: 'legacy',
        providers: {
          legacy: {
            name: 'legacy',
            base_url: 'http://127.0.0.1:5510/v1',
            wire_api: 'responses',
            env_key: 'LEGACY_KEY',
            model: 'legacy-model',
            enabled: true,
          },
        },
      },
      preferences: {
        defaultModel: 'legacy-model',
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
    }, null, 2), 'utf-8');

    writeFileSync(configPath, JSON.stringify({
      kernel: {
        provider: 'tcm',
        providers: {
          tcm: {
            name: 'tcm',
            base_url: 'http://127.0.0.1:5555',
            wire_api: 'responses',
            env_key: 'ROUTECODEX_HTTP_APIKEY',
            model: 'gpt-5.4',
            enabled: true,
          },
        },
      },
    }, null, 2), 'utf-8');

    const { loadUserSettings } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    expect(settings.aiProviders.default).toBe('tcm');
    expect(settings.aiProviders.providers.tcm?.base_url).toBe('http://127.0.0.1:5555');
    expect(settings.aiProviders.providers.legacy).toBeUndefined();
  });

  it('persists provider updates into config.json kernel section', async () => {
    const { loadUserSettings, saveUserSettings } = await import('../../../src/core/user-settings.js');
    const settings = loadUserSettings();
    settings.aiProviders.providers.rcm = {
      name: 'rcm',
      base_url: 'http://127.0.0.1:5520',
      wire_api: 'responses',
      env_key: 'ROUTECODEX_HTTP_APIKEY',
      model: 'gpt-5.4',
      enabled: true,
    };
    settings.aiProviders.default = 'rcm';
    saveUserSettings(settings);

    const configPath = path.join(tempHome, 'config', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.kernel?.provider).toBe('rcm');
    expect(config.kernel?.providers?.rcm?.base_url).toBe('http://127.0.0.1:5520');
  });
});
