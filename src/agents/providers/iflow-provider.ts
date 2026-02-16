// iFlow REST Provider Implementation (for HTTP mode)
import { AgentSDK, RequestOptions } from '../shared/types.js';

export interface IFlowConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

interface IFlowApiErrorPayload {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
  message?: string;
  code?: string | number;
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

  private async readErrorBody(response: Response): Promise<string> {
    try {
      const text = await response.text();
      if (!text) return '';
      return text.length > 500 ? text.slice(0, 500) + '...' : text;
    } catch {
      return '';
    }
  }

  private parseErrorBody(errorText: string): string {
    if (!errorText) return '';

    try {
      const payload = JSON.parse(errorText) as IFlowApiErrorPayload;
      const message = payload.error?.message ?? payload.message;
      const code = payload.error?.code ?? payload.code;
      const type = payload.error?.type;
      const details = [message, code ? `code=${String(code)}` : '', type ? `type=${type}` : '']
        .filter(Boolean)
        .join(', ');
      return details || errorText;
    } catch {
      return errorText;
    }
  }

  private async throwApiError(response: Response, endpoint: string, model?: string): Promise<never> {
    const errorText = await this.readErrorBody(response);
    const parsed = this.parseErrorBody(errorText);
    const modelPart = model ? ` model=${model}` : '';
    throw new Error(
      `iFlow API error: status=${response.status} endpoint=${endpoint}${modelPart}` +
      (parsed ? ` details=${parsed}` : '')
    );
  }

  async request(prompt: string, options?: RequestOptions): Promise<string> {
    const model = options?.model || this.defaultModel;
    const endpoint = '/v1/chat/completions';

    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(options?.systemPrompt ? [{ role: 'system', content: options.systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 2048,
      }),
    });

    if (!response.ok) {
      await this.throwApiError(response, endpoint, model);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  }

  async listModels(): Promise<string[]> {
    const endpoint = '/models';
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      await this.throwApiError(response, endpoint);
    }

    const data = await response.json() as { data?: Array<{ id: string }> };
    return data.data?.map((m) => m.id) || [];
  }
}
