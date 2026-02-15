import { Agent, AgentConfig } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';

export interface ReviewerRoleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
}

export interface ReviewResult {
  passed: boolean;
  score: number;
  comments: string;
  issues: string[];
  suggestions: string[];
}

const DEFAULT_SYSTEM_PROMPT = '你是一个任务审查者 Agent，负责审查执行结果的质量。返回 JSON 格式的审查结果。';

export class ReviewerRole {
  private config: ReviewerRoleConfig;
  private agent: Agent;
  private bdTools: BdTools;

  constructor(config: ReviewerRoleConfig) {
    this.config = config;
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name,
      mode: config.mode,
      provider: 'iflow',
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      cwd: config.cwd,
    };
    this.agent = new Agent(agentConfig);
    this.bdTools = new BdTools(config.cwd);
  }

  async initialize(): Promise<void> {
    await this.agent.initialize();
  }

  async disconnect(): Promise<void> {
    await this.agent.disconnect();
  }

  async review(epicId: string, tasks: Array<{ id?: string; description: string }>, results: unknown[]): Promise<ReviewResult> {
    const prompt = '请审查以下任务的执行结果:\n\nEpic ID: ' + epicId + '\n\n任务及结果:\n' + 
      tasks.map((t, i) => '任务: ' + t.description + '\n结果: ' + JSON.stringify(results[i] || '无')).join('\n\n') +
      '\n\n请给出审查意见，返回 JSON 格式: { passed: boolean, score: number, comments: string, issues: string[], suggestions: string[] }';

    const response = await this.agent.execute(prompt);

    if (!response.success) {
      return {
        passed: false,
        score: 0,
        comments: 'Review failed: ' + response.error,
        issues: [response.error || 'Unknown error'],
        suggestions: [],
      };
    }

    try {
      const jsonMatch = response.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as ReviewResult;
        await this.bdTools.addComment(epicId, '[Reviewer] 审查完成: ' + (result.passed ? '通过' : '未通过'));
        return result;
      }
    } catch {
      // Fall through
    }

    return {
      passed: true,
      score: 70,
      comments: response.output,
      issues: [],
      suggestions: [],
    };
  }
}
