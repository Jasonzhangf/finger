/**
 * Anthropic Wire Protocol Adapter
 *
 * 实现 Anthropic Messages API (https://docs.anthropic.com/en/api/messages)
 * 兼容 ali-coding-plan (Dashscope Anthropic-compatible) 等 Anthropic Wire 服务
 */

import axios, { type AxiosInstance } from 'axios';
import type {
  LLMProvider,
  LLMChatRequest,
  LLMChatResponse,
  LLMStreamEvent,
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
  AnthropicContentBlock,
  AnthropicToolUseBlock,
  AnthropicTextBlock,
  AnthropicToolDefinition,
} from '../provider-types.js';

export function createAnthropicWireProvider(config: {
  id: string;
  apiKey: string;
  baseURL: string;
  defaultModel?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}): LLMProvider {
  const client: AxiosInstance = axios.create({
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 60000,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      ...config.headers,
    },
  });

  /**
   * 将 Finger 内部格式转换为 Anthropic Messages API 请求格式
   */
  function formatAnthropicRequest(request: LLMChatRequest): AnthropicMessagesRequest {
    // 拆分 system prompt 和 messages
    const systemPrompt = request.systemPrompt ?? '';
    const messages = request.messages.map((m) => {
      if (m.role === 'system') {
        return null; // system 已提取到顶层
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
      };
    }).filter(Boolean) as Array<{ role: 'user' | 'assistant'; content: string }>;

    // Anthropic tool 格式
    const tools: AnthropicToolDefinition[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: (t.inputSchema as object) ?? { type: 'object', properties: {} },
    }));

    // tool_choice 映射
    let tool_choice: AnthropicMessagesRequest['tool_choice'] = undefined;
    if (request.toolChoice === 'required') {
      tool_choice = { type: 'any' };
    } else if (request.toolChoice === 'none') {
      tool_choice = { type: 'none' };
    } else {
      tool_choice = { type: 'auto' };
    }

    return {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages,
      temperature: request.temperature,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(tool_choice ? { tool_choice } : {}),
      ...(request.stopSequences && request.stopSequences.length > 0
        ? { stop_sequences: request.stopSequences }
        : {}),
    };
  }

  /**
   * 将 Anthropic Messages API 响应转换为 Finger 内部格式
   */
  function parseAnthropicResponse(response: AnthropicMessagesResponse): LLMChatResponse {
    const contentBlocks = response.content;

    // 提取文本块
    const textBlocks = contentBlocks.filter(
      (b): b is AnthropicTextBlock => b.type === 'text'
    );
    const content = textBlocks.map((b) => b.text).join('\n');

    // 提取工具调用块
    const toolBlocks = contentBlocks.filter(
      (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
    );
    const toolCalls = toolBlocks.map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input,
    }));

    // finish reason 映射
    let finishReason: LLMChatResponse['finishReason'];
    switch (response.stop_reason) {
      case 'end_turn':
      case 'stop_sequence':
        finishReason = 'stop';
        break;
      case 'max_tokens':
        finishReason = 'length';
        break;
      case 'tool_use':
        finishReason = 'tool_use';
        break;
      default:
        finishReason = 'stop';
    }

    return {
      id: response.id,
      model: response.model,
      content,
      finishReason,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    };
  }

  async function chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const body = formatAnthropicRequest(request);

    const { data } = await client.post<AnthropicMessagesResponse>(
      '/v1/messages',
      body
    );

    return parseAnthropicResponse(data);
  }

  async function* stream(
    request: LLMChatRequest
  ): AsyncIterable<LLMStreamEvent> {
    const body = formatAnthropicRequest(request);

    const response = await client.post('/v1/messages', body, {
      headers: { Accept: 'text/event-stream' },
      responseType: 'stream',
    });

    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield {
              type: 'text',
              text: parsed.delta.text,
            };
          } else if (
            parsed.type === 'message_delta' &&
            parsed.delta?.stop_reason
          ) {
            yield {
              type: 'finish',
              finishReason:
                parsed.delta.stop_reason === 'end_turn' ? 'stop' : 'tool_use',
            };
          }
        } catch {
          // 跳过无法解析的 SSE 行
        }
      }
    }
  }

  async function listModels(): Promise<string[]> {
    // Anthropic 没有标准的 list models endpoint
    // 返回已知模型列表
    return [
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-3-5-sonnet-20241022',
      'glm-5',
      'glm-4.7',
      'kimi-k2.5',
      'qwen3.5-plus',
      'qwen3-coder-plus',
      'MiniMax-M2.5',
    ];
  }

  return {
    id: config.id,
    type: 'anthropic-wire' as const,
    chat,
    stream,
    listModels,
    formatRequest: formatAnthropicRequest,
    parseResponse: parseAnthropicResponse,
  };
}
