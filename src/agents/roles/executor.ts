import { IFlowProvider } from '../providers/iflow-provider.js';
import { AgentMessage, TaskAssignment, MessageMode, ExecutionFeedback } from '../protocol/schema.js';
import { ToolRegistry } from '../shared/tool-registry.js';
import { BdTools } from '../shared/bd-tools.js';

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

export enum ExecutorState {
  idle = 'idle',
  claiming = 'claiming',
  thinking = 'thinking',
  acting = 'acting',
  observing = 'observing',
  completing = 'completing',
  failed = 'failed',
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
  private bdTools?: BdTools;
  private state: ExecutorState = ExecutorState.idle;
  private currentTask?: TaskAssignment;

  constructor(config: ExecutorConfig, bdTools?: BdTools) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
    this.toolRegistry = config.toolRegistry;
    this.bdTools = bdTools;
  }

  /**
   * 执行者核心循环：Thought → Action → Observation
   */
  async executeTask(task: TaskAssignment): Promise<ExecutionResult> {
    this.currentTask = task;
    
    // 领取任务
    if (task.bdTaskId && this.bdTools) {
      await this.claimTask(task.bdTaskId);
    }

    const startTime = Date.now();

    try {
      // Thought: 构建执行思路
      this.state = ExecutorState.thinking;
      const thinkPrompt = this.buildThinkPrompt(task);
      const thought = await this.provider.request(thinkPrompt, {
        systemPrompt: this.config.systemPrompt,
      });

      // Action: 决定具体行动
      this.state = ExecutorState.acting;
      const actPrompt = this.buildActPrompt(task, thought);
      const action = await this.provider.request(actPrompt, {
        systemPrompt: this.config.systemPrompt,
      });

      // 执行工具调用（如果有）
      this.state = ExecutorState.observing;
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

      // 完成任务
      this.state = ExecutorState.completing;
      if (task.bdTaskId && this.bdTools) {
        await this.bdTools.closeTask(task.bdTaskId, '执行成功完成', [
          { type: 'result', content: action },
          { type: 'log', content: observation },
        ]);
      }

      return { success: true, feedback };
    } catch (error) {
      this.state = ExecutorState.failed;
      const feedback: ExecutionFeedback = {
        taskId: task.taskId,
        success: false,
        result: '',
        observation: error instanceof Error ? error.message : 'Execution failed',
        metrics: {
          duration: Date.now() - startTime,
        },
      };

      if (task.bdTaskId && this.bdTools) {
        await this.bdTools.updateStatus(task.bdTaskId, 'blocked');
        await this.bdTools.addComment(task.bdTaskId, 
          `[Executor] 执行失败: ${feedback.observation}`
        );
      }

      return {
        success: false,
        feedback,
        error: feedback.observation,
      };
    } finally {
      this.state = ExecutorState.idle;
      this.currentTask = undefined;
    }
  }

  /**
   * 领取任务
   */
  private async claimTask(taskId: string): Promise<void> {
    this.state = ExecutorState.claiming;
    if (this.bdTools) {
      await this.bdTools.updateStatus(taskId, 'in_progress');
      await this.bdTools.addComment(taskId, 
        `[${this.config.id}] 领取任务，开始执行`
      );
    }
  }

  /**
   * 获取当前状态
   */
  getState(): ExecutorState {
    return this.state;
  }

  /**
   * 获取当前任务
   */
  getCurrentTask(): TaskAssignment | undefined {
    return this.currentTask;
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
