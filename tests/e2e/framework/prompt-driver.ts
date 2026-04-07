/**
 * Prompt Driver for E2E Multi-Agent Tests
 * 
 * Sends natural language prompts to System Agent and tracks responses.
 * Task: finger-280.6
 */

import { logger } from '../../../src/core/logger.js';

const log = logger.module('PromptDriver');

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  name: string;
  template: string;
  variables?: Record<string, string>;
}

export interface PromptResponse {
  promptId: string;
  prompt: string;
  response?: string;
  timestamp: number;
  durationMs: number;
  status: 'pending' | 'completed' | 'timeout' | 'error';
  error?: string;
}

export interface PromptDriverConfig {
  defaultTimeoutMs?: number;
  pollIntervalMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Pre-defined Prompt Templates for Test Scenarios
// ─────────────────────────────────────────────────────────────

export const SCENARIO_PROMPTS = {
  scenario1_single_agent: {
    id: 'scenario-1',
    name: 'Simple Task - Single Agent',
    template: '帮我分析当前 finger 项目的日志结构，列出所有模块的日志覆盖情况',
  },
  
  scenario2_parallel_agents: {
    id: 'scenario-2',
    name: 'Complex Task - Parallel Agents',
    template: `帮我对 finger 项目进行代码审查：
1. 分析 \`src/blocks/\` 的测试覆盖率
2. 检查 \`src/orchestration/\` 的内存泄露隐患
3. 审查 \`src/tools/internal/\` 工具实现是否符合设计文档
请同时开始这三项审查`,
  },
  
  scenario3_dynamic_decomposition: {
    id: 'scenario-3',
    name: 'Dynamic Task Decomposition',
    template: '从 datareportal.com 下载最新的年度报告，保存到 ~/Documents/reports/，然后提取关键数据做摘要',
  },
  
  scenario4_inter_agent_comm: {
    id: 'scenario-4',
    name: 'Inter-Agent Communication',
    template: '派一个 agent 分析 webauto 项目的任务队列状况，同时派另一个检查 finger 项目的 heartbeat 状态，然后汇总两个项目的健康状况',
  },
  
  scenario5_timeout: {
    id: 'scenario-5a',
    name: 'Timeout Scenario',
    template: '下载一个不存在的网站数据，持续尝试直到完成',
  },
  
  scenario5_injection: {
    id: 'scenario-5b',
    name: 'Failure Injection Scenario',
    template: '分析 finger 项目的测试覆盖率',
  },
} as const;

// ─────────────────────────────────────────────────────────────
// Prompt Driver Class
// ─────────────────────────────────────────────────────────────

export class PromptDriver {
  private readonly config: Required<PromptDriverConfig>;
  private readonly responseHistory: PromptResponse[] = [];
  private promptCounter = 0;

  constructor(config: PromptDriverConfig = {}) {
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs ?? 60000,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
    };
    log.debug('PromptDriver initialized', { config: this.config });
  }

  /**
   * Render a prompt template with variables
   */
  renderTemplate(template: PromptTemplate, variables?: Record<string, string>): string {
    let rendered = template.template;
    if (variables) {
      for (const [key, value] of Object.entries(variables)) {
        rendered = rendered.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
      }
    }
    return rendered;
  }

  /**
   * Send a prompt and wait for response
   * Note: In real implementation, this would interact with channel/mailbox
   */
  async sendPrompt(
    prompt: string,
    timeoutMs?: number
  ): Promise<PromptResponse> {
    const promptId = `prompt-${++this.promptCounter}`;
    const startTime = Date.now();
    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;

    log.info('Sending prompt', { promptId, prompt: prompt.slice(0, 100) });

    // Record prompt
    const response: PromptResponse = {
      promptId,
      prompt,
      timestamp: startTime,
      durationMs: 0,
      status: 'pending',
    };

    this.responseHistory.push(response);

    // Simulate waiting for agent response
    // In real implementation, this would:
    // 1. Send prompt via channel/mailbox to system agent
    // 2. Poll for response
    // 3. Extract agent's reply
    
    // For now, just mark as completed (real implementation needed)
    await new Promise(resolve => setTimeout(resolve, 100));
    
    response.status = 'completed';
    response.response = 'Mock response - implement real channel integration';
    response.durationMs = Date.now() - startTime;

    log.info('Prompt completed', { promptId, durationMs: response.durationMs });

    return response;
  }

  /**
   * Execute multiple prompts in sequence
   */
  async multiTurn(
    prompts: Array<string | PromptTemplate>,
    options?: { timeoutMs?: number; stopOnError?: boolean }
  ): Promise<PromptResponse[]> {
    const results: PromptResponse[] = [];
    const stopOnError = options?.stopOnError ?? true;

    for (const prompt of prompts) {
      const promptText = typeof prompt === 'string' ? prompt : prompt.template;
      const result = await this.sendPrompt(promptText, options?.timeoutMs);
      results.push(result);

      if (stopOnError && result.status === 'error') {
        log.warn('Multi-turn stopped due to error', { promptId: result.promptId });
        break;
      }
    }

    return results;
  }

  /**
   * Get response history
   */
  getHistory(): PromptResponse[] {
    return [...this.responseHistory];
  }

  /**
   * Clear history
   */
  clearHistory(): void {
    this.responseHistory.length = 0;
    this.promptCounter = 0;
  }
}
