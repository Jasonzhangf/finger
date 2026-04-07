import { ProviderRegistry } from '../../../src/providers/provider-registry.js';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = ProviderRegistry.getInstance();
    registry.clear();
  });

  describe('register', () => {
    it('registers a provider', () => {
      const provider = {
        id: 'test-provider',
        type: 'openai-compatible' as const,
        chat: async () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
        formatRequest: () => {},
        parseResponse: () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
      };
      const config = {
        id: 'test-provider',
        type: 'openai-compatible' as const,
        apiKey: 'test-key',
        baseURL: 'http://localhost:8080',
      };

      registry.register(provider, config);
      expect(registry.has('test-provider')).toBe(true);
      expect(registry.get('test-provider')).toBe(provider);
    });
  });

  describe('setDefault', () => {
    it('sets default provider', () => {
      const provider = {
        id: 'default-provider',
        type: 'openai-compatible' as const,
        chat: async () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
        formatRequest: () => {},
        parseResponse: () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
      };
      const config = {
        id: 'default-provider',
        type: 'openai-compatible' as const,
        apiKey: 'test-key',
        baseURL: 'http://localhost:8080',
      };

      registry.register(provider, config);
      registry.setDefault('default-provider');
      expect(registry.getDefaultId()).toBe('default-provider');
      expect(registry.getDefault()).toBe(provider);
    });

    it('throws error when setting unregistered provider as default', () => {
      expect(() => registry.setDefault('unregistered')).toThrow('Provider unregistered not registered');
    });
  });

  describe('getAvailableProviders', () => {
    it('returns empty array when no providers registered', () => {
      expect(registry.getAvailableProviders()).toEqual([]);
    });

    it('returns all registered provider ids', () => {
      const provider1 = {
        id: 'provider-1',
        type: 'openai-compatible' as const,
        chat: async () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
        formatRequest: () => {},
        parseResponse: () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
      };
      const provider2 = {
        id: 'provider-2',
        type: 'anthropic-wire' as const,
        chat: async () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
        formatRequest: () => {},
        parseResponse: () => ({ id: '1', model: 'test', content: 'hello', finishReason: 'stop' }),
      };

      registry.register(provider1, { id: 'provider-1', type: 'openai-compatible', apiKey: 'key1', baseURL: 'http://localhost:8080' });
      registry.register(provider2, { id: 'provider-2', type: 'anthropic-wire', apiKey: 'key2', baseURL: 'http://localhost:8081' });

      expect(registry.getAvailableProviders()).toEqual(['provider-1', 'provider-2']);
    });
  });

  describe('loadFromUserSettings', () => {
    it('loads providers from user settings', () => {
      // Mock environment variable
      process.env.TEST_API_KEY = 'test-key-value';

      const settings = {
        defaultProvider: 'test-provider',
        providers: {
          'test-provider': {
            name: 'Test Provider',
            base_url: 'http://localhost:8080',
            env_key: 'TEST_API_KEY',
            model: 'test-model',
            enabled: true,
          },
          'disabled-provider': {
            name: 'Disabled Provider',
            base_url: 'http://localhost:8081',
            env_key: 'DISABLED_API_KEY',
            model: 'disabled-model',
            enabled: false,
          },
        },
      };

      registry.loadFromUserSettings(settings);

      expect(registry.has('test-provider')).toBe(true);
      expect(registry.has('disabled-provider')).toBe(false);
      expect(registry.getDefaultId()).toBe('test-provider');

      // Cleanup
      delete process.env.TEST_API_KEY;
    });

    it('skips providers without API key', () => {
      const settings = {
        defaultProvider: 'no-key-provider',
        providers: {
          'no-key-provider': {
            name: 'No Key Provider',
            base_url: 'http://localhost:8080',
            env_key: 'MISSING_API_KEY',
            model: 'test-model',
            enabled: true,
          },
        },
      };

      registry.loadFromUserSettings(settings);

      expect(registry.has('no-key-provider')).toBe(false);
    });
  });
});
