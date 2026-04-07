/**
 * Provider Factory
 * 
 * 根据 config.type 创建对应的 provider 实例
 * 禁止硬编码，所有参数从配置读取
 */

import type { LLMProvider, LLMProviderConfig, LLMProviderType } from './provider-types.js';
import { logger } from '../core/logger.js';

const log = logger.module('ProviderFactory');

/**
 * 创建 provider 实例
 */
export function createProvider(config: LLMProviderConfig): LLMProvider {
  log.debug('Creating provider', { id: config.id, type: config.type });

  switch (config.type) {
    case 'openai-compatible':
      // Phase 2 会实现完整的 OpenAI-compatible adapter
      // 这里先用 stub，等待 Phase 2 实现
      return createOpenAICompatibleProviderStub(config);
    
    case 'anthropic-wire':
      // Phase 3 会实现完整的 Anthropic Wire adapter
      return createAnthropicWireProviderStub(config);
    
    case 'openai-native':
      // Phase 2 会实现
      return createOpenAINativeProviderStub(config);
    
    case 'custom':
      throw new Error('Custom provider requires plugin registration');
    
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/**
 * OpenAI-compatible provider stub (Phase 2 会实现完整版本)
 */
function createOpenAICompatibleProviderStub(config: LLMProviderConfig): LLMProvider {
  return {
    id: config.id,
    type: 'openai-compatible',

    async chat(request) {
      // Phase 2 会实现完整的 HTTP 调用
      throw new Error('OpenAI-compatible provider not implemented yet. Wait for Phase 2.');
    },

    formatRequest(request) {
      // OpenAI-compatible 请求格式
      return {
        model: request.model,
        messages: request.messages.map(m => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content,
        })),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stop: request.stopSequences,
        tools: request.tools,
        tool_choice: request.toolChoice,
      };
    },

    parseResponse(response: unknown) {
      // OpenAI-compatible 响应解析
      const resp = response as any;
      const choice = resp.choices?.[0];
      return {
        id: resp.id || 'unknown',
        model: resp.model || request.model,
        content: choice?.message?.content || '',
        finishReason: mapOpenAIFinishReason(choice?.finish_reason),
        toolCalls: choice?.message?.tool_calls,
        usage: {
          inputTokens: resp.usage?.prompt_tokens || 0,
          outputTokens: resp.usage?.completion_tokens || 0,
          totalTokens: resp.usage?.total_tokens || 0,
        },
      };
    },
  };
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
 * OpenAI Native provider stub (Phase 2 会实现完整版本)
 */
function createOpenAINativeProviderStub(config: LLMProviderConfig): LLMProvider {
  // OpenAI Native 与 OpenAI-compatible 类似，但可能有特殊处理（如 o1/o3 的 reasoning tokens）
  return createOpenAICompatibleProviderStub(config);
}

/**
 * OpenAI finish_reason 映射
 */
function mapOpenAIFinishReason(reason: string | undefined): 'stop' | 'tool_use' | 'length' | 'error' {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'length';
    default:
      return 'error';
  }
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
