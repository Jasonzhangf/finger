export interface RequestOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

export interface AgentSDK {
  request(prompt: string, options?: RequestOptions): Promise<string>;
  listModels(): Promise<string[]>;
}

export interface RoleConfig {
  name: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  maxTurns: number;
  allowedTools?: string[];
  permissionMode: 'default' | 'autoEdit' | 'yolo' | 'plan';
}

export interface RoleExecutionResult {
  result: string;
  reasoning: string[];
  actions: string[];
}
