/**
 * AI Provider 模块
 * 
 * 导出所有 provider 类型、registry、factory
 */

export { createOpenAICompatibleProvider, OpenAICompatibleProvider } from './protocols/openai-compatible.js';

export {
  // Types
  LLMProviderType,
  LLMProviderConfig,
  LLMChatRequest,
  LLMChatResponse,
  ChatMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  LLMStreamEvent,
  LLMProvider,
  
  // Functions
  parseModelId,
  detectProtocolType,
} from './provider-types.js';

export {
  ProviderRegistry,
  AIProviderConfigEntry,
  UserSettingsAIProviders,
} from './provider-registry.js';

export {
  createProvider,
} from './provider-factory.js';
