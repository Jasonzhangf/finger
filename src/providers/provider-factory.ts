/**
 * Provider Factory
 * 
 * 根据 config.type 创建对应的 provider 实例
 * 禁止硬编码，所有参数从配置读取
 */

import type { LLMProvider, LLMProviderConfig } from './provider-types.js';
import { createOpenAICompatibleProvider } from './protocols/openai-compatible.js';
import { createAnthropicWireProvider } from './protocols/anthropic-wire.js';
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
      return createAnthropicWireProvider(config);
    
    case 'openai-native':
      // OpenAI Native 与 OpenAI-compatible 类似，暂时复用
      return createOpenAICompatibleProvider(config);
    
    case 'custom':
      throw new Error('Custom provider requires plugin registration');
    
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}
