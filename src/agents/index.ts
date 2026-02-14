// Agent SDK abstraction layer
// Role -> Agent -> AI Provider

export interface AgentSDK {
  request(prompt: string, options?: RequestOptions): Promise<string>;
  listModels(): Promise<string[]>;
}

export interface RequestOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
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

export abstract class BaseRole {
  abstract readonly roleType: string;
  abstract readonly config: RoleConfig;

  constructor(protected sdk: AgentSDK) {}

  // ReAct loop for role execution
  async executeTask(task: string, _context?: Record<string, unknown>): Promise<{
    result: string;
    reasoning: string[];
    actions: string[];
  }> {
    const reasoning: string[] = [];
    const actions: string[] = [];

    // Thought
    const thought = await this.think(task, _context);
    reasoning.push(thought);

    // Action
    const action = await this.act(thought, _context);
    actions.push(action);

    // Observation (in real implementation, this would be the result of the action)
    const observation = await this.observe(action);
    reasoning.push(observation);

    // Final result
    const result = await this.finalize(reasoning, actions);

    return { result, reasoning, actions };
  }

  protected async think(task: string, _context?: Record<string, unknown>): Promise<string> {
    const prompt = this.buildThinkPrompt(task, _context);
    return this.sdk.request(prompt, {
      systemPrompt: this.config.systemPrompt,
      temperature: 0.7,
    });
  }

  protected async act(thought: string, _context?: Record<string, unknown>): Promise<string> {
    const prompt = this.buildActPrompt(thought, _context);
    return this.sdk.request(prompt, {
      systemPrompt: this.config.systemPrompt,
      temperature: 0.3,
    });
  }

  protected async observe(action: string): Promise<string> {
    return `Observed result of: ${action}`;
  }

  protected async finalize(reasoning: string[], actions: string[]): Promise<string> {
    const prompt = `Based on the following reasoning and actions, provide a final result:
Reasoning:
${reasoning.join('\n')}
Actions:
${actions.join('\n')}`;
    return this.sdk.request(prompt, {
      systemPrompt: this.config.systemPrompt,
      temperature: 0.5,
    });
  }

  protected abstract buildThinkPrompt(task: string, _context?: Record<string, unknown>): string;
  protected abstract buildActPrompt(thought: string, _context?: Record<string, unknown>): string;
}

// Role definitions
export class OrchestratorRole extends BaseRole {
  readonly roleType = 'orchestrator';
  readonly config: RoleConfig = {
    name: 'Orchestrator',
    description: 'Task decomposition and project management',
    systemPrompt: `You are an Orchestrator agent responsible for:
1. Analyzing user requests and breaking them down into subtasks
2. Creating and managing task dependencies
3. Assigning tasks to appropriate agents based on their capabilities
4. Monitoring task progress and handling dependencies
5. Integrating results and providing final output
Always think step by step and plan before acting.`,
    capabilities: ['decompose', 'schedule', 'assign', 'monitor', 'integrate'],
    maxTurns: 10,
    permissionMode: 'plan',
  };

  protected buildThinkPrompt(task: string, _context?: Record<string, unknown>): string {
    return `Task to orchestrate: ${task}
Context: ${JSON.stringify(_context || {})}
Think about how to break this down into subtasks and assign them.`;
  }

  protected buildActPrompt(thought: string, _context?: Record<string, unknown>): string {
    return `Based on your thought: ${thought}
What specific actions should you take to orchestrate this task?
Consider creating subtasks, assigning to agents, or monitoring progress.`;
  }
}

export class ExecutorRole extends BaseRole {
  readonly roleType = 'executor';
  readonly config: RoleConfig = {
    name: 'Executor',
    description: 'Code execution and file operations',
    systemPrompt: `You are an Executor agent responsible for:
1. Implementing code based on specifications
2. Writing and modifying files
3. Running tests and verifying results
4. Reporting execution status and errors
Focus on precise execution and error handling.`,
    capabilities: ['code', 'write', 'test', 'execute', 'verify'],
    maxTurns: 20,
    permissionMode: 'autoEdit',
    allowedTools: ['file', 'terminal', 'git'],
  };

  protected buildThinkPrompt(task: string, _context?: Record<string, unknown>): string {
    return `Execution task: ${task}
Context: ${JSON.stringify(_context || {})}
Think about the implementation approach and potential issues.`;
  }

  protected buildActPrompt(thought: string, _context?: Record<string, unknown>): string {
    return `Based on your thought: ${thought}
What code or files should you create/modify?
Provide specific implementation steps.`;
  }
}

export class ReviewerRole extends BaseRole {
  readonly roleType = 'reviewer';
  readonly config: RoleConfig = {
    name: 'Reviewer',
    description: 'Code review and quality checking',
    systemPrompt: `You are a Reviewer agent responsible for:
1. Reviewing code for quality and best practices
2. Checking for bugs and potential issues
3. Verifying compliance with standards
4. Providing constructive feedback
Be thorough and detail-oriented in your reviews.`,
    capabilities: ['review', 'analyze', 'report', 'suggest'],
    maxTurns: 5,
    permissionMode: 'default',
  };

  protected buildThinkPrompt(task: string, _context?: Record<string, unknown>): string {
    return `Review task: ${task}
Context: ${JSON.stringify(_context || {})}
Think about what aspects need review and potential issues.`;
  }

  protected buildActPrompt(thought: string, _context?: Record<string, unknown>): string {
    return `Based on your thought: ${thought}
What specific review actions should you take?
Identify issues, suggest improvements, or approve.`;
  }
}

export class TesterRole extends BaseRole {
  readonly roleType = 'tester';
  readonly config: RoleConfig = {
    name: 'Tester',
    description: 'Test writing and execution',
    systemPrompt: `You are a Tester agent responsible for:
1. Writing comprehensive test cases
2. Executing tests and reporting results
3. Identifying edge cases and coverage gaps
4. Automating test execution
Ensure thorough testing and clear reporting.`,
    capabilities: ['write_test', 'run_test', 'report', 'automate'],
    maxTurns: 15,
    permissionMode: 'autoEdit',
    allowedTools: ['file', 'terminal'],
  };

  protected buildThinkPrompt(task: string, _context?: Record<string, unknown>): string {
    return `Testing task: ${task}
Context: ${JSON.stringify(_context || {})}
Think about test cases needed and testing strategy.`;
  }

  protected buildActPrompt(thought: string, _context?: Record<string, unknown>): string {
    return `Based on your thought: ${thought}
What tests should you write or execute?
Provide specific test cases and expected results.`;
  }
}

export class ArchitectRole extends BaseRole {
  readonly roleType = 'architect';
  readonly config: RoleConfig = {
    name: 'Architect',
    description: 'Architecture design and technical decisions',
    systemPrompt: `You are an Architect agent responsible for:
1. Designing system architecture
2. Making technical decisions and trade-offs
3. Defining interfaces and contracts
4. Ensuring scalability and maintainability
Focus on high-level design and clear documentation.`,
    capabilities: ['design', 'decide', 'document', 'review_arch'],
    maxTurns: 8,
    permissionMode: 'plan',
  };

  protected buildThinkPrompt(task: string, _context?: Record<string, unknown>): string {
    return `Architecture task: ${task}
Context: ${JSON.stringify(_context || {})}
Think about design patterns, trade-offs, and system structure.`;
  }

  protected buildActPrompt(thought: string, _context?: Record<string, unknown>): string {
    return `Based on your thought: ${thought}
What architectural decisions and designs should you document?
Provide clear specifications and rationale.`;
  }
}

// SDK Implementations
export class IFlowSDK implements AgentSDK {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;

  constructor(config: { baseUrl: string; apiKey: string; defaultModel: string }) {
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

// Agent factory
export class AgentFactory {
  static createRole(roleType: string, sdk: AgentSDK): BaseRole {
    switch (roleType) {
      case 'orchestrator':
        return new OrchestratorRole(sdk);
      case 'executor':
        return new ExecutorRole(sdk);
      case 'reviewer':
        return new ReviewerRole(sdk);
      case 'tester':
        return new TesterRole(sdk);
      case 'architect':
        return new ArchitectRole(sdk);
      default:
        throw new Error(`Unknown role type: ${roleType}`);
    }
  }

  static createIFlowAgent(config: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  }): AgentSDK {
    return new IFlowSDK(config);
  }
}

// Re-export types
export type { AgentSDK, RequestOptions, RoleConfig };
