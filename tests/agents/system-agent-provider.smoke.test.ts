import { describe, it, expect } from 'vitest';
import { loadUserSettings } from '../../src/core/user-settings.js';

const shouldRun = process.env.FINGER_PROVIDER_SMOKE === '1';
const userSettings = shouldRun ? loadUserSettings() : null;
const defaultProvider = userSettings?.aiProviders?.default;
const providerConfig = defaultProvider ? userSettings?.aiProviders?.providers?.[defaultProvider] : null;
const apiKey = providerConfig?.env_key ? process.env[providerConfig.env_key] : undefined;
const describeFn = shouldRun && apiKey ? describe : describe.skip;

describeFn('System Agent Provider Smoke Test', () => {

  it('should load user settings successfully', () => {
    expect(userSettings).toBeDefined();
    expect(userSettings.version).toBe('1.0');
    expect(userSettings.aiProviders).toBeDefined();
  });

  it('should have correct provider configuration', () => {
    expect(providerConfig).toBeDefined();
    expect(providerConfig.name).toBe(defaultProvider);
    expect(providerConfig.base_url).toBeTruthy();
    expect(providerConfig.wire_api).toBeTruthy();
    expect(providerConfig.model).toBeTruthy();
    expect(providerConfig.enabled).toBe(true);
  });

  it('should verify API key is configured', () => {
    expect(apiKey).toBeDefined();
    expect(apiKey).toBeTruthy();
  });

  it('should verify provider is reachable - /v1/models endpoint', async () => {
    const response = await fetch(`${providerConfig.base_url}/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.object).toBe('list');
    expect(data.data).toBeInstanceOf(Array);
    expect(data.data.length).toBeGreaterThan(0);
  });

  it('should verify provider can complete requests - /v1/chat/completions', async () => {
    const response = await fetch(`${providerConfig.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: providerConfig.model,
        messages: [
          { role: 'user', content: 'test' }
        ],
        max_tokens: 10
      })
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.choices).toBeInstanceOf(Array);
    expect(data.choices.length).toBeGreaterThan(0);
    expect(data.choices[0].message).toBeDefined();
    expect(data.choices[0].message.content).toBeDefined();
    expect(data.choices[0].message.content.length).toBeGreaterThan(0);
  }, 30000);
});
