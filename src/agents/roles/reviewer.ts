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

export interface PreActReviewInput {
  task: string;
  round: number;
  thought: string;
  action: string;
  params: Record<string, unknown>;
  expectedOutcome?: string;
  risk?: string;
  availableTools: string[];
  prompt?: string;
}

export interface PreActReviewOutput {
  approved: boolean;
  score: number;
  feedback: string;
  requiredFixes: string[];
  riskLevel: 'low' | 'medium' | 'high';
  alternativeAction?: string;
  confidence?: number;
}

const DEFAULT_SYSTEM_PROMPT = `你是一个任务审查者 Agent，负责审查执行方案和执行结果的质量。

审查原则:
1. 严格优先：不确定就拒绝，不模糊通过
2. 安全优先：高风险操作必须拒绝
3. 完整优先：参数不完整必须拒绝
4. 可验证优先：预期结果不可验证必须拒绝

输出要求:
- 必须返回 JSON 格式
- 明确给出通过/拒绝
- 提供具体修正建议`;

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

  /**
   * 执行前审查 (Pre-Act Review)
   * 在 Action 执行前审查方案合理性
   */
  async reviewPreAct(input: PreActReviewInput): Promise<PreActReviewOutput> {
    const prompt = input.prompt ?? `请审查以下 Action 方案（执行前审查）：

任务: ${input.task}
当前轮次: ${input.round}

方案详情:
- Thought: ${input.thought}
- Action: ${input.action}
- Params: ${JSON.stringify(input.params, null, 2)}
- ExpectedOutcome: ${input.expectedOutcome || '未说明'}
- Risk: ${input.risk || '未评估'}
- 可用工具: ${input.availableTools.join(', ')}

请返回 JSON:
{
  "approved": boolean,
  "score": number,
  "feedback": "详细反馈",
  "requiredFixes": ["需要修正的问题"],
  "riskLevel": "low|medium|high",
  "alternativeAction": "更好的替代方案",
  "confidence": number
}`;

    const response = await this.agent.execute(prompt);

    if (!response.success) {
      return {
        approved: false,
        score: 0,
        feedback: 'Review failed: ' + response.error,
        requiredFixes: [response.error || 'Unknown error'],
        riskLevel: 'high',
        confidence: 0,
      };
    }

    try {
      const jsonMatch = response.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as PreActReviewOutput;
        return {
          approved: Boolean(parsed.approved),
          score: typeof parsed.score === 'number' ? parsed.score : 50,
          feedback: parsed.feedback || 'No feedback provided',
          requiredFixes: Array.isArray(parsed.requiredFixes) ? parsed.requiredFixes : [],
          riskLevel: ['low', 'medium', 'high'].includes(parsed.riskLevel) ? parsed.riskLevel : 'high',
          alternativeAction: parsed.alternativeAction,
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
        };
      }
    } catch {
      // Fall through
    }

    return {
      approved: false,
      score: 50,
      feedback: response.output,
      requiredFixes: ['Failed to parse review output as JSON'],
      riskLevel: 'high',
      confidence: 30,
    };
  }

  /**
   * 执行后审查 (Post-Act Review)
   * 审查已执行任务的完成质量
   */
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
