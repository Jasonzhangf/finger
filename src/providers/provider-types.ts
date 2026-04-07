/**
 * AI Provider 类型定义
 * 
 * 支持多协议：OpenAI-compatible、Anthropic Wire、OpenAI Native
 * 所有配置从 user-settings.json 读取，禁止硬编码
 */

export type LLMProviderType = 'openai-compatible' | 'anthropic-wire' | 'openai-native' | 'custom';

export interface LLMProviderConfig {
  id: string;                      // provider ID (e.g., 'iflow', 'anthropic', 'openai')
  type: LLMProviderType;
  apiKey: string;
  baseURL: string;
  defaultModel?: string;           // 从配置读取，禁止硬编码
  timeoutMs?: number;              // 从配置读取，禁止硬编码
  headers?: Record<string, string>;
}

export interface LLMChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none';
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMChatResponse {
  id: string;
  model: string;
  content: string;
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface LLMStreamEvent {
  type: 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop';
  index?: number;
  delta?: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
  contentBlock?: ContentBlock;
  message?: { id: string; model: string; usage?: { inputTokens: number; outputTokens: number } };
}

export interface LLMProvider {
  readonly id: string;
  readonly type: LLMProviderType;
  
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
  stream?(request: LLMChatRequest): AsyncIterable<LLMStreamEvent>;
  listModels?(): Promise<string[]>;
  
  // 协议适配
  formatRequest(request: LLMChatRequest): unknown;
  parseResponse(response: unknown): LLMChatResponse;
}

/**
 * 从模型 ID 解析出 provider 和实际模型名
 * 支持格式：
 * - "anthropic:claude-sonnet-4" → { provider: "anthropic", model: "claude-sonnet-4" }
 * - "openai:gpt-5" → { provider: "openai", model: "gpt-5" }
 * - "iflow.kimi-k2.5" → { provider: "iflow", model: "kimi-k2.5" }
 */
export function parseModelId(
  modelId: string,
  availableProviders: string[]
): { provider: string | null; model: string } {
  const colonIndex = modelId.indexOf(':');
  
  if (colonIndex !== -1) {
    const prefix = modelId.slice(0, colonIndex);
    const model = modelId.slice(colonIndex + 1);
    
    if (availableProviders.includes(prefix)) {
      return { provider: prefix, model };
    }
  }
  
  // Dot notation: "iflow.kimi-k2.5" → provider=iflow, model=kimi-k2.5
  const dotIndex = modelId.indexOf('.');
  if (dotIndex !== -1) {
    const prefix = modelId.slice(0, dotIndex);
    if (availableProviders.includes(prefix)) {
      return { provider: prefix, model: modelId.slice(dotIndex + 1) };
    }
  }
  
  // 无 provider 前缀，返回 null 表示使用默认 provider
  return { provider: null, model: modelId };
}

/**
 * 协议检测逻辑（从配置推断）
 * 禁止硬编码，完全基于 baseURL 和 model 配置
 */
export function detectProtocolType(config: { baseURL: string; defaultModel?: string }): LLMProviderType {
  const baseURL = config.baseURL.toLowerCase();
  const model = (config.defaultModel || '').toLowerCase();
  
  // Anthropic Wire: baseURL 包含 anthropic.com 或 model 以 claude- 开头
  if (baseURL.includes('anthropic.com') || model.startsWith('claude-')) {
    return 'anthropic-wire';
  }
  
  // OpenAI Native: baseURL 包含 api.openai.com 或 model 以 o1/o3 开头
  if (baseURL.includes('api.openai.com') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('gpt-')) {
    return 'openai-native';
  }
  
  // 默认：OpenAI-compatible（兼容 Iflow/RouteCodex）
  return 'openai-compatible';
}
