import { IFlowProvider } from '../providers/iflow-provider.js';
import { BdTools } from '../shared/bd-tools.js';

export interface SummaryConfig {
  id: string;
  systemPrompt: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  };
}

export class SummaryRole {
  private config: SummaryConfig;
  private provider: IFlowProvider;
  private bdTools?: BdTools;

  constructor(config: SummaryConfig, bdTools?: BdTools) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
    this.bdTools = bdTools;
  }

  /**
   * 生成最终总结
   */
  async summarize(epicId: string, reviewOutput: any): Promise<any> {
    const prompt = this.buildSummaryPrompt(epicId, reviewOutput);
    try {
      const response = await this.provider.request(prompt, {
        systemPrompt: this.config.systemPrompt,
      });

      try {
        return JSON.parse(response);
      } catch {
        return { raw: response };
      }
    } catch (error) {
      console.error('[Summary] Summary failed:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * 构建总结提示词
   */
  private buildSummaryPrompt(epicId: string, reviewOutput: any): string {
    return `你是一个总结 Agent，负责为以下 Epic 生成最终总结报告。

Epic ID: ${epicId}

审查结果:
${JSON.stringify(reviewOutput, null, 2)}

请以 JSON 格式返回总结，包含:
{
  "summary": "整体执行情况总结",
  "keyFindings": ["..."],
  "nextSteps": ["..."]
}`;
  }
}
