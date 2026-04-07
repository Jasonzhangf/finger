/**
 * OpenAI-compatible Provider
 * 
 * 兼容 OpenAI /v1/chat/completions 协议
 * 支持 Iflow、RouteCodex、OpenAI 等兼容实现
 * 
 * 所有配置从 provider.config 读取，禁止硬编码
 */

import axios, { type AxiosInstance, type AxiosError } from 'axios';
import type { LLMProvider, LLMChatRequest, LLMChatResponse, ChatMessage, ContentBlock, ToolCall } from '../provider-types.js';
import type { LLMProviderConfig } from '../provider-types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('OpenAICompatibleProvider');

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  stream?: boolean;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIChatResponse {
  id: string;
  model: string;
  created: number;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: OpenAIUsage;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly type = 'openai-compatible';

  private http: AxiosInstance;
  private config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.id = config.id;
    this.type = 'openai-compatible';
    this.config = config;

    this.http = axios.create({
      baseURL: config.baseURL.replace(/\/$/, ''),
      timeout: config.timeoutMs ?? 30000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const payload = this.formatRequest(request);
    
    log.debug('Sending chat request', {
      model: request.model,
      baseURL: this.config.baseURL,
      messagesCount: request.messages.length,
      toolsCount: request.tools?.length ?? 0,
    });

    try {
      const response = await this.http.post<OpenAIChatResponse>('/v1/chat/completions', payload);
      return this.parseResponse(response.data, request);
    } catch (error) {
      const axiosError = error as AxiosError;
      log.error('Chat request failed', {
        status: axiosError.response?.status,
        data: axiosError.response?.data,
        model: request.model,
      });
      throw new Error(`OpenAI-compatible request failed: ${axiosError.message}`);
    }
  }

  formatRequest(request: LLMChatRequest): OpenAIChatRequest {
    const messages: OpenAIChatMessage[] = [];

    // System prompt
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    // User/assistant messages
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        messages.push({ role: msg.role, content: msg.content });
      } else {
        // ContentBlock 数组，提取 text
        const text = msg.content
          .filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join('\n');
        messages.push({ role: msg.role, content: text });
      }
    }

    const payload: OpenAIChatRequest = {
      model: request.model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: request.stopSequences,
    };

    // Tools
    if (request.tools && request.tools.length > 0) {
      payload.tools = request.tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }

    // Tool choice
    if (request.toolChoice) {
      if (request.toolChoice === 'auto' || request.toolChoice === 'required' || request.toolChoice === 'none') {
        payload.tool_choice = request.toolChoice;
      } else {
        payload.tool_choice = { type: 'function', function: request.toolChoice };
      }
    }

    return payload;
  }

  parseResponse(response: OpenAIChatResponse, request: LLMChatRequest): LLMChatResponse {
    const choice = response.choices[0];
    const content = choice.message.content ?? '';
    
    // Parse tool calls
    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    // Map finish reason
    let finishReason: LLMChatResponse['finishReason'] = 'error';
    switch (choice.finish_reason) {
      case 'stop':
        finishReason = 'stop';
        break;
      case 'tool_calls':
        finishReason = 'tool_use';
        break;
      case 'length':
        finishReason = 'length';
        break;
    }

    return {
      id: response.id,
      model: response.model,
      content,
      finishReason,
      toolCalls,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }
}

/**
 * 创建 OpenAI-compatible provider 实例
 */
export function createOpenAICompatibleProvider(config: LLMProviderConfig): LLMProvider {
  return new OpenAICompatibleProvider(config);
}
