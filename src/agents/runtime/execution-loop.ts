import { MessageBus } from './message-bus.js';
import { ToolRegistry } from '../shared/tool-registry.js';
import { OrchestratorRole, AgentConfig } from '../roles/orchestrator.js';
import { ExecutorRole, ExecutorConfig } from '../roles/executor.js';
import { BdTools } from '../shared/bd-tools.js';
import { TaskAssignment, ExecutionFeedback, AgentMessage } from '../protocol/schema.js';

export interface LoopConfig {
  orchestrator: AgentConfig;
  maxRounds: number;
  timeout: number;
}

export interface LoopResult {
  success: boolean;
  completedTasks: TaskAssignment[];
  failedTasks: TaskAssignment[];
  totalRounds: number;
  duration: number;
}

export class ExecutionLoop {
  private orchestrator: OrchestratorRole;
  private executors: Map<string, ExecutorRole> = new Map();
  private messageBus: MessageBus;
  private toolRegistry: ToolRegistry;
  private loopConfig: LoopConfig;
  private bdTools: BdTools;

  constructor(
    messageBus: MessageBus,
    toolRegistry: ToolRegistry,
    config: LoopConfig
  ) {
    this.messageBus = messageBus;
    this.toolRegistry = toolRegistry;
    this.loopConfig = config;
    this.bdTools = new BdTools();
    this.orchestrator = new OrchestratorRole(config.orchestrator, this.bdTools);
  }

  /**
   * 注册执行者
   */
  registerExecutor(config: ExecutorConfig): void {
    const executor = new ExecutorRole(config, this.bdTools);
    this.executors.set(config.id, executor);

    // 订阅该执行者的消息
    this.messageBus.subscribe(config.id, async (msg) => {
      await this.handleMessage(config.id, msg);
    });
  }

  /**
   * 运行编排循环
   */
  async run(originalTask: string): Promise<LoopResult> {
    const startTime = Date.now();
    const completedTasks: TaskAssignment[] = [];
    const failedTasks: TaskAssignment[] = [];
    let remainingTasks: TaskAssignment[] = [];
    let round = 0;

    // 订阅编排者消息
    const orchId = this.loopConfig.orchestrator.id;
    this.messageBus.subscribe(orchId, (_msg) => {
      // 编排者收到反馈后的处理
    });

    while (round < this.loopConfig.maxRounds) {
      round++;

      // 1. 编排者拆解任务
      const availableRoles = Array.from(this.executors.keys());
      const availableTools = this.toolRegistry.list().map(t => t.name);

      const decomposeResult = await this.orchestrator.decomposeTask(
        originalTask,
        availableRoles,
        availableTools
      );

      if (!decomposeResult.success || !decomposeResult.tasks?.length) {
        if (remainingTasks.length === 0) {
          break;
        }
        // 等待剩余任务完成
        await this.wait(100);
        continue;
      }

      const tasks = decomposeResult.tasks;

      // 2. 分配任务给执行者
      for (const task of tasks) {
        const executorId = this.selectExecutor(task);
        if (!executorId) {
          failedTasks.push(task);
          continue;
        }

        // 赋予工具权限
        for (const toolName of task.tools) {
          this.toolRegistry.grant(executorId, {
            toolName,
            action: 'grant',
          });
        }

        // 发送任务消息
        const msg = this.orchestrator.createTaskMessage(executorId, task);
        await this.messageBus.send(msg);

        remainingTasks.push(task);
      }

      // 3. 等待执行结果
      const results = await this.collectResults(remainingTasks, this.loopConfig.timeout);

      for (const result of results) {
        if (result.success) {
          completedTasks.push(result.task);
        } else {
          failedTasks.push(result.task);
        }
        remainingTasks = remainingTasks.filter(t => t.taskId !== result.task.taskId);
      }

      // 4. 检查是否完成
      if (remainingTasks.length === 0 && failedTasks.length === 0) {
        break;
      }

      // 5. 如果有失败，重新规划
      if (failedTasks.length > 0 && round < this.loopConfig.maxRounds) {
        const replanResult = await this.orchestrator.replan(
          completedTasks,
          failedTasks,
          remainingTasks,
          'Retry failed tasks'
        );
        if (replanResult.success && replanResult.tasks) {
          remainingTasks.push(...replanResult.tasks);
          failedTasks.length = 0;
        }
      }
    }

    return {
      success: failedTasks.length === 0 && completedTasks.length > 0,
      completedTasks,
      failedTasks,
      totalRounds: round,
      duration: Date.now() - startTime,
    };
  }

  /**
   * 处理收到的消息
   */
  private async handleMessage(executorId: string, msg: AgentMessage): Promise<void> {
    if (!msg.payload.task) return;

    const executor = this.executors.get(executorId);
    if (!executor) return;

    const result = await executor.executeTask(msg.payload.task);
    if (result.feedback) {
      const feedbackMsg = executor.createFeedbackMessage(
        this.loopConfig.orchestrator.id,
        result.feedback
      );
      await this.messageBus.send(feedbackMsg);
    }
  }

  /**
   * 选择合适的执行者
   */
  private selectExecutor(task: TaskAssignment): string | null {
    const executorIds = Array.from(this.executors.keys());
    if (executorIds.length === 0) return null;

    // 简单轮询选择
    const index = Math.abs(hashCode(task.taskId)) % executorIds.length;
    return executorIds[index];
  }

  /**
   * 收集执行结果
   */
  private async collectResults(
    tasks: TaskAssignment[],
    timeout: number
  ): Promise<Array<{ task: TaskAssignment; success: boolean; feedback?: ExecutionFeedback }>> {
    const results: Array<{ task: TaskAssignment; success: boolean; feedback?: ExecutionFeedback }> = [];
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline && results.length < tasks.length) {
      const history = this.messageBus.getHistory(this.loopConfig.orchestrator.id);

      for (const msg of history) {
        if (msg.payload.feedback) {
          const task = tasks.find(t => t.taskId === msg.payload.feedback?.taskId);
          if (task && !results.find(r => r.task.taskId === task.taskId)) {
            results.push({
              task,
              success: msg.payload.feedback.success,
              feedback: msg.payload.feedback,
            });
          }
        }
      }

      await this.wait(50);
    }

    // 标记超时任务为失败
    for (const task of tasks) {
      if (!results.find(r => r.task.taskId === task.taskId)) {
        results.push({ task, success: false });
      }
    }

    return results;
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}
