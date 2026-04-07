/**
 * ali-coding-plan E2E Test
 *
 * 测试 Anthropic Wire 协议的端到端调用
 * 使用 ~/.finger/config/user-settings.json 中配置的 ali-coding-plan provider
 */

import { ProviderRegistry } from '../../../src/providers/provider-registry.js';
import type { LLMChatRequest } from '../../../src/providers/provider-types.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('ali-coding-plan E2E', () => {
  let registry: ProviderRegistry;

  beforeAll(() => {
    registry = ProviderRegistry.getInstance();
    registry.clear();
    registry.loadFromDefaultPath();
  });

  afterAll(() => {
    registry.clear();
  });

  it('should load ali-coding-plan provider from user-settings.json', () => {
    const provider = registry.get('ali-coding-plan');
    expect(provider).toBeDefined();
    expect(provider?.type).toBe('anthropic-wire');
    expect(provider?.id).toBe('ali-coding-plan');
  });

  it('should set ali-coding-plan as default provider', () => {
    const defaultId = registry.getDefaultId();
    expect(defaultId).toBe('ali-coding-plan');
  });

  it('should send a basic chat request and receive response', async () => {
    const provider = registry.getDefault();
    expect(provider).toBeDefined();

    const request: LLMChatRequest = {
      model: 'glm-5', // 从配置读取
      messages: [{ role: 'user', content: 'Hello, respond with just "Hi" in one word.' }],
      maxTokens: 100,
      temperature: 0.1,
    };

    const response = await provider!.chat(request);

    expect(response.id).toBeDefined();
    expect(response.model).toBe('glm-5');
    expect(response.content).toBeDefined();
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toBeDefined();
    expect(response.usage!.inputTokens).toBeGreaterThan(0);
    expect(response.usage!.outputTokens).toBeGreaterThan(0);
  }, 60000);

  it('should send a request with system prompt', async () => {
    const provider = registry.getDefault();
    expect(provider).toBeDefined();

    const request: LLMChatRequest = {
      model: 'glm-5',
      systemPrompt: 'You are a helpful coding assistant. Be concise.',
      messages: [{ role: 'user', content: 'What is the output of 2+2? Just the number.' }],
      maxTokens: 50,
    };

    const response = await provider!.chat(request);

    expect(response.content).toBeDefined();
    expect(response.content).toContain('4');
  }, 60000);

  it('should handle multi-turn conversation', async () => {
    const provider = registry.getDefault();
    expect(provider).toBeDefined();

    const request: LLMChatRequest = {
      model: 'glm-5',
      messages: [
        { role: 'user', content: 'My name is Jason.' },
        { role: 'assistant', content: 'Hello Jason! How can I help you today?' },
        { role: 'user', content: 'What is my name?' },
      ],
      maxTokens: 100,
    };

    const response = await provider!.chat(request);

    expect(response.content).toBeDefined();
    expect(response.content.toLowerCase()).toContain('jason');
  }, 60000);
});
