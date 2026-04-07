import { OpenAICompatibleProvider } from '../../../src/providers/protocols/openai-compatible.js';
import type { LLMChatRequest } from '../../../src/providers/provider-types.js';

describe('OpenAICompatibleProvider', () => {
  const config = {
    id: 'test-provider',
    type: 'openai-compatible' as const,
    apiKey: 'test-api-key',
    baseURL: 'http://localhost:8080',
    timeoutMs: 10000,
  };

  describe('formatRequest', () => {
    it('formats basic chat request', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      };

      const formatted = provider.formatRequest(request);

      expect(formatted.model).toBe('test-model');
      expect(formatted.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
      expect(formatted.temperature).toBeUndefined();
      expect(formatted.max_tokens).toBeUndefined();
    });

    it('formats request with system prompt', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: 'You are a helpful assistant.',
      };

      const formatted = provider.formatRequest(request);

      expect(formatted.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('formats request with tools', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            name: 'test_tool',
            description: 'A test tool',
            inputSchema: { type: 'object', properties: { param: { type: 'string' } } },
          },
        ],
        toolChoice: 'auto',
      };

      const formatted = provider.formatRequest(request);

      expect(formatted.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'A test tool',
            parameters: { type: 'object', properties: { param: { type: 'string' } } },
          },
        },
      ]);
      expect(formatted.tool_choice).toBe('auto');
    });

    it('formats request with ContentBlock array', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          },
        ],
      };

      const formatted = provider.formatRequest(request);

      expect(formatted.messages).toEqual([
        { role: 'user', content: 'Line 1\nLine 2' },
      ]);
    });
  });

  describe('parseResponse', () => {
    it('parses basic response', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const openAIResponse = {
        id: 'chat-123',
        model: 'test-model',
        created: 1234567890,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello back!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      const parsed = provider.parseResponse(openAIResponse, request);

      expect(parsed.id).toBe('chat-123');
      expect(parsed.model).toBe('test-model');
      expect(parsed.content).toBe('Hello back!');
      expect(parsed.finishReason).toBe('stop');
      expect(parsed.toolCalls).toBeUndefined();
      expect(parsed.usage).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
    });

    it('parses response with tool calls', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const openAIResponse = {
        id: 'chat-123',
        model: 'test-model',
        created: 1234567890,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tool-1',
                  type: 'function',
                  function: { name: 'test_tool', arguments: '{"param": "value"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };

      const parsed = provider.parseResponse(openAIResponse, request);

      expect(parsed.content).toBe('');
      expect(parsed.finishReason).toBe('tool_use');
      expect(parsed.toolCalls).toEqual([
        { id: 'tool-1', name: 'test_tool', input: { param: 'value' } },
      ]);
    });

    it('parses response with length finish reason', () => {
      const provider = new OpenAICompatibleProvider(config);
      const request: LLMChatRequest = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const openAIResponse = {
        id: 'chat-123',
        model: 'test-model',
        created: 1234567890,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello back!' },
            finish_reason: 'length',
          },
        ],
      };

      const parsed = provider.parseResponse(openAIResponse, request);

      expect(parsed.finishReason).toBe('length');
    });
  });
});
