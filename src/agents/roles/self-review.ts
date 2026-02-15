import { IFlowProvider } from '../providers/iflow-provider.js';
import { AgentMessage, MessageMode } from '../protocol/schema.js';
import { BdTools } from '../shared/bd-tools.js';

export interface SelfReviewConfig {
  id: string;
  systemPrompt: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  };
}

export class SelfReviewRole {
  private config: SelfReviewConfig;
  private provider: IFlowProvider;
  private bdTools?: BdTools;

  constructor(config: SelfReviewConfig, bdTools?: BdTools) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
    this.bdTools = bdTools;
  }

  /**
   * 审查任务执行结果
   */
  async review(epicId: string, tasks: any[], results: any[]): Promise<any> {
    const prompt = this.buildReviewPrompt(epicId, tasks, results);
    try {
      const response = await this.provider.request(prompt, {
        systemPrompt: this.config.systemPrompt,
      });

      // 尝试解析 JSON 结果，如果失败则返回原始文本
      try {
        return JSON.parse(response);
      } catch {
        return { raw: response };
      }
    } catch (error) {
      console.error('[SelfReview] Review failed:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 构建审查提示词
   */
  private buildReviewPrompt(epicId: string, tasks: any[], results: any[]): string {
    return `你是一个自审 Agent，负责审查以下任务执行结果的质量。

Epic ID: ${epicId}

任务列表及执行结果:
${tasks.map((t, i) => `
任务: ${t.description}
结果: ${JSON.stringify(results[i] || '无')}`).join('\n')}

请给出总体审查意见，包括:
1. 各任务是否达到预期目标
2. 潜在问题或风险
3. 改进建议
4. 总体通过标记 (passed: true/false)

以 JSON 格式返回，例如:
{
  "passed": true,
  "comments": "所有任务完成良好，但第3项可优化...",
  "issues": ["..."],
  "suggestions": ["..."]
}`;
  }
}
