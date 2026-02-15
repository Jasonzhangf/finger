import { IFlowProvider } from '../providers/iflow-provider.js';
import { AgentMessage, TaskAssignment, MessageMode, ExecutionFeedback } from '../protocol/schema.js';
import { ToolRegistry } from '../shared/tool-registry.js';

export interface ExecutorConfig {
  id: string;
  systemPrompt: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  };
  toolRegistry: ToolRegistry;
}

export interface ExecutionResult {
  success: boolean;
  feedback?: ExecutionFeedback;
  error?: string;
}

export class ExecutorRole {
  private config: ExecutorConfig;
  private provider: IFlowProvider;
  private toolRegistry: ToolRegistry;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
    this.toolRegistry = config.toolRegistry;
  }

  /**
   * 执行者核心循环：Thought → Action → Observation
   */
  async executeTask(task: TaskAssignment): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Thought: 构建执行思路
      const thinkPrompt = this.buildThinkPrompt(task);
      const thought = await this.provider.request(thinkPrompt, {
        systemPrompt: this.config.systemPrompt,
      });

      // Action: 决定具体行动
      const actPrompt = this.buildActPrompt(task, thought);
      const action = await this.provider.request(actPrompt, {
        systemPrompt: this.config.systemPrompt,
      });

      // 执行工具调用（如果有）
      const observation = await this.executeTools(task);

      // 构建反馈
      const feedback: ExecutionFeedback = {
        taskId: task.taskId,
        success: true,
        result: action,
        observation,
        metrics: {
          duration: Date.now() - startTime,
        },
      };

      return { success: true, feedback };
    } catch (error) {
      const feedback: ExecutionFeedback = {
        taskId: task.taskId,
        success: false,
        result: '',
        observation: error instanceof Error ? error.message : 'Execution failed',
        metrics: {
          duration: Date.now() - startTime,
        },
      };

      return {
        success: false,
        feedback,
        error: feedback.observation,
      };
    }
  }

  /**
   * 创建执行反馈消息
   */
  createFeedbackMessage(
    orchestratorId: string,
    feedback: ExecutionFeedback
  ): AgentMessage {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      sender: this.config.id,
      receiver: orchestratorId,
      mode: 'execute' as MessageMode,
      status: 'completed',
      payload: { feedback },
    };
  }

  getRole(): string {
    return 'executor';
  }

  /**
   * 构建思考提示词
   */
  private buildThinkPrompt(task: TaskAssignment): string {
    const grantedTools = this.toolRegistry.listGranted(this.config.id);
    const toolsDesc = grantedTools.map(t => t.toolName).join(', ');

    return `你是一个任务执行者。请思考如何完成以下任务。

任务: ${task.description}
可用工具: ${toolsDesc || '无'}

请分析:
1. 任务目标是什么
2. 需要哪些步骤
3. 每一步需要什么工具
4. 可能遇到的问题和解决方案`;
  }

  /**
   * 构建行动提示词
   */
  private buildActPrompt(task: TaskAssignment, thought: string): string {
    return `基于你的思考:
${thought}

请执行任务: ${task.description}

输出执行结果。`;
  }

  /**
   * 执行工具调用
   */
  private async executeTools(task: TaskAssignment): Promise<string> {
    const results: string[] = [];

    for (const toolName of task.tools) {
      if (!this.toolRegistry.canUse(this.config.id, toolName)) {
        results.push(`[DENIED] Tool '${toolName}' not granted`);
        continue;
      }

      const execResult = await this.toolRegistry.execute(this.config.id, toolName, {
        taskId: task.taskId,
      });

      if (execResult.success) {
        results.push(`[OK] ${toolName}: ${JSON.stringify(execResult.result)}`);
      } else {
        results.push(`[FAIL] ${toolName}: ${execResult.error}`);
      }
    }

    return results.join('\n');
  }
}
