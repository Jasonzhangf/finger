// iFlow SDK Provider Implementation
import { AgentSDK, RequestOptions } from '../shared/types.js';

export interface IFlowConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

export class IFlowProvider implements AgentSDK {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(config: IFlowConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
  }

  async request(prompt: string, options?: RequestOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || this.defaultModel,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2048,
      }),
    });

    if (!response.ok) {
      throw new Error(`iFlow API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async listModels(): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`iFlow API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data?.map((m: { id: string }) => m.id) || [];
  }
}
