/**
 * Embedding Adapter
 *
 * 支持:
 * - local: LM Studio 兼容的 OpenAI 格式 endpoint
 * - openai: OpenAI API
 * - anthropic: Anthropic API (如果支持 embeddings)
 */

import { loadMemoryConfig, MemoryConfig } from './memory-config.js';

export interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}

export class EmbeddingAdapter {
  private config: MemoryConfig;

  constructor(config?: MemoryConfig) {
    this.config = config ?? loadMemoryConfig();
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const { provider } = this.config.embedding;

    switch (provider) {
      case 'local':
        return this.embedWithOpenAIFormat(text);
      case 'openai':
        return this.embedWithOpenAIFormat(text);
      case 'anthropic':
        return this.embedWithOpenAIFormat(text); // Anthropic 通常用 OpenAI 兼容格式
      default:
        throw new Error(`Unknown embedding provider: ${provider}`);
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const { provider } = this.config.embedding;

    switch (provider) {
      case 'local':
      case 'openai':
      case 'anthropic':
        return this.embedBatchWithOpenAIFormat(texts);
      default:
        throw new Error(`Unknown embedding provider: ${provider}`);
    }
  }

  private async embedWithOpenAIFormat(text: string): Promise<EmbeddingResult> {
    const { baseUrl, model, apiKey } = this.config.embedding;
    const url = `${baseUrl}/embeddings`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: text,
        model: model || 'text-embedding-ada-002',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return {
      embedding: data.data[0].embedding,
      tokens: data.usage?.total_tokens ?? 0,
    };
  }

  private async embedBatchWithOpenAIFormat(texts: string[]): Promise<EmbeddingResult[]> {
    const { baseUrl, model, apiKey } = this.config.embedding;
    const url = `${baseUrl}/embeddings`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: texts,
        model: model || 'text-embedding-ada-002',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return data.data.map((item, index) => ({
      embedding: item.embedding,
      tokens: index === 0 ? data.usage?.total_tokens ?? 0 : 0,
    }));
  }
}

let defaultAdapter: EmbeddingAdapter | null = null;

export function getEmbeddingAdapter(config?: MemoryConfig): EmbeddingAdapter {
  if (!defaultAdapter || config) {
    defaultAdapter = new EmbeddingAdapter(config);
  }
  return defaultAdapter;
}
