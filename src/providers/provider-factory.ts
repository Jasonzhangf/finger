/**
 * Provider Factory
 * 
 * 根据 config.type 创建对应的 provider 实例
 * 禁止硬编码，所有参数从配置读取
 */

import type { LLMProvider, LLMProviderConfig, LLMProviderType } from './provider-types.js';
import { createOpenAICompatibleProvider } from './protocols/openai-compatible.js';
import { logger } from '../core/logger.js';

const log = logger.module('ProviderFactory');

/**
 * 创建 provider 实例
 */
export function createProvider(config: LLMProviderConfig): LLMProvider {
  log.debug('Creating provider', { id: config.id, type: config.type });

  switch (config.type) {
    case 'openai-compatible':
      return createOpenAICompatibleProvider(config);
    
    case 'anthropic-wire':
      // Phase 3 会实现完整的 Anthropic Wire adapter
      return createAnthropicWireProviderStub(config);
    
    case 'openai-native':
      // OpenAI Native 与 OpenAI-compatible 类似，暂时复用
      return createOpenAICompatibleProvider(config);
    
    case 'custom':
      throw new Error('Custom provider requires plugin registration');
    
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/**
 * Anthropic Wire provider stub (Phase 3 会实现完整版本)
 */
function createAnthropicWireProviderStub(config: LLMProviderConfig): LLMProvider {
  return {
    id: config.id,
    type: 'anthropic-wire',

    async chat(request) {
      throw new Error('Anthropic Wire provider not implemented yet. Wait for Phase 3.');
    },

    formatRequest(request) {
      // Anthropic Messages API 请求格式
      return {
        model: request.model,
        max_tokens: request.maxTokens || 4096,
        system: request.systemPrompt,
        messages: request.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content,
        })),
        tools: request.tools?.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      };
    },

    parseResponse(response: unknown) {
      // Anthropic Messages API 响应解析
      const resp = response as any;
      const contentBlocks = resp.content || [];
      const textBlocks = contentBlocks.filter(b => b.type === 'text');
      const toolBlocks = contentBlocks.filter(b => b.type === 'tool_use');

      return {
        id: resp.id || 'unknown',
        model: resp.model || request.model,
        content: textBlocks.map(b => b.text).join('\n'),
        finishReason: mapAnthropicStopReason(resp.stop_reason),
        toolCalls: toolBlocks.map(b => ({
          id: b.id,
          name: b.name,
          input: b.input,
        })),
        usage: {
          inputTokens: resp.usage?.input_tokens || 0,
          outputTokens: resp.usage?.output_tokens || 0,
          totalTokens: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0),
        },
      };
    },
  };
}

/**
 * Anthropic stop_reason 映射
 */
function mapAnthropicStopReason(reason: string | undefined): 'stop' | 'tool_use' | 'length' | 'error' {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'length';
    default:
      return 'error';
  }
}
