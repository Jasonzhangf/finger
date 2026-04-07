import { parseModelId, detectProtocolType } from '../../../src/providers/provider-types.js';

describe('Provider Types', () => {
  describe('parseModelId', () => {
    const providers = ['iflow', 'anthropic', 'openai'];

    it('parses colon notation: anthropic:claude-sonnet-4', () => {
      const result = parseModelId('anthropic:claude-sonnet-4', providers);
      expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4' });
    });

    it('parses colon notation: openai:gpt-5', () => {
      const result = parseModelId('openai:gpt-5', providers);
      expect(result).toEqual({ provider: 'openai', model: 'gpt-5' });
    });

    it('parses dot notation: iflow.kimi-k2.5', () => {
      const result = parseModelId('iflow.kimi-k2.5', providers);
      expect(result).toEqual({ provider: 'iflow', model: 'kimi-k2.5' });
    });

    it('returns null provider for unknown prefix', () => {
      const result = parseModelId('unknown.model-name', providers);
      expect(result).toEqual({ provider: null, model: 'unknown.model-name' });
    });

    it('returns null provider for plain model id', () => {
      const result = parseModelId('kimi-k2.5', providers);
      expect(result).toEqual({ provider: null, model: 'kimi-k2.5' });
    });

    it('returns null provider for unknown colon prefix', () => {
      const result = parseModelId('grok:model-1', providers);
      expect(result).toEqual({ provider: null, model: 'grok:model-1' });
    });
  });

  describe('detectProtocolType', () => {
    it('detects anthropic-wire from baseURL', () => {
      expect(detectProtocolType({ baseURL: 'https://api.anthropic.com/v1' }))
        .toBe('anthropic-wire');
    });

    it('detects anthropic-wire from model name', () => {
      expect(detectProtocolType({ baseURL: 'http://localhost:8080', defaultModel: 'claude-sonnet-4' }))
        .toBe('anthropic-wire');
    });

    it('detects openai-native from baseURL', () => {
      expect(detectProtocolType({ baseURL: 'https://api.openai.com/v1' }))
        .toBe('openai-native');
    });

    it('detects openai-native from model name o1', () => {
      expect(detectProtocolType({ baseURL: 'http://localhost:8080', defaultModel: 'o1-preview' }))
        .toBe('openai-native');
    });

    it('detects openai-native from model name gpt-', () => {
      expect(detectProtocolType({ baseURL: 'http://localhost:8080', defaultModel: 'gpt-5' }))
        .toBe('openai-native');
    });

    it('defaults to openai-compatible for unknown providers', () => {
      expect(detectProtocolType({ baseURL: 'http://127.0.0.1:8765' }))
        .toBe('openai-compatible');
    });

    it('defaults to openai-compatible for iflow', () => {
      expect(detectProtocolType({ baseURL: 'http://127.0.0.1:8765', defaultModel: 'kimi-k2.5' }))
        .toBe('openai-compatible');
    });
  });
});
