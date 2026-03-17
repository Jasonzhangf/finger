import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
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

  it('throws when config.json is missing', async () => {
    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).rejects.toThrow('AI provider config not found');
  });

  it('passes when valid config.json is present', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');

    const config = {
      kernel: {
        provider: 'tcm',
        providers: {
          tcm: {
            name: 'tcm',
            base_url: 'http://127.0.0.1:5555/v1',
            wire_api: 'responses',
            env_key: 'ROUTECODEX_HTTP_APIKEY',
            model: 'gpt-5.4',
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).resolves.toBeUndefined();
  });

  it('throws when default provider missing', async () => {
    const configDir = path.join(tempHome, 'config');
    mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'config.json');

    const config = {
      kernel: {
        provider: 'missing',
        providers: {
          tcm: {
            name: 'tcm',
            base_url: 'http://127.0.0.1:5555/v1',
            wire_api: 'responses',
            env_key: 'ROUTECODEX_HTTP_APIKEY',
            model: 'gpt-5.4',
          },
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const { checkAIProviderConfig } = await import('../../../src/server/modules/ai-provider-config.js');
    await expect(checkAIProviderConfig()).rejects.toThrow('Default AI provider not configured or invalid');
  });
});
