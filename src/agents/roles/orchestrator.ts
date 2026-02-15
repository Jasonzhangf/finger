import { IFlowProvider } from '../providers/iflow-provider.js';
import { AgentMessage, TaskAssignment, MessageMode } from '../protocol/schema.js';
import { BdTools } from '../shared/bd-tools.js';

export interface DecomposeResult {
  success: boolean;
  tasks?: TaskAssignment[];
  error?: string;
}

export interface AgentConfig {
  id: string;
  systemPrompt: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    defaultModel: string;
  };
}

export enum OrchestratorState {
  understanding = 'understanding',
  planning = 'planning',
  dispatching = 'dispatching',
  monitoring = 'monitoring',
  replanning = 'replanning',
  completing = 'completing',
  failed = 'failed',
}

export interface OrchestratorContext {
  originalTask: string;
  currentPlan: TaskAssignment[];
  pendingTasks: TaskAssignment[];
  completedTasks: TaskAssignment[];
  failedTasks: TaskAssignment[];
  clarifications: string[];
  currentEpicId?: string;
}

export class OrchestratorRole {
  private config: AgentConfig;
  private provider: IFlowProvider;
  private bdTools: BdTools;
  private state: OrchestratorState = OrchestratorState.understanding;
  private context: OrchestratorContext = {
    originalTask: '',
    currentPlan: [],
    pendingTasks: [],
    completedTasks: [],
    failedTasks: [],
    clarifications: [],
  };

  constructor(config: AgentConfig, bdTools: BdTools) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
    this.bdTools = bdTools;
  }

  /**
   * 启动编排会话
   */
  async startOrchestration(userTask: string): Promise<string> {
    this.context.originalTask = userTask;
    
    // 创建 Epic
    const epic = await this.bdTools.createTask({
      title: userTask,
      type: 'epic',
      priority: 0,
      labels: ['orchestration'],
    });
    
    this.context.currentEpicId = epic.id;
    this.state = OrchestratorState.understanding;
    
    await this.bdTools.addComment(epic.id, 
      `[Orchestrator] 状态: ${this.state} | 正在分析任务意图...`
    );
    
    return epic.id;
  }

  /**
   * 编排者核心方法：拆解任务为子任务
   * 基于 ReACT 模式：Thought → Action(assign subtasks)
   */
  async decomposeTask(
    originalTask: string,
    availableRoles: string[],
    availableTools: string[]
  ): Promise<DecomposeResult> {
    if (this.state !== OrchestratorState.planning) {
      await this.bdTools.addComment(this.context.currentEpicId!, 
        `[Orchestrator] 进入 planning 状态`
      );
      this.state = OrchestratorState.planning;
    }

    const prompt = this.buildDecomposePrompt(originalTask, availableRoles, availableTools);

    try {
      const response = await this.provider.request(prompt, {
        systemPrompt: this.config.systemPrompt,
      });

      const tasks = this.parseTaskAssignments(response, this.config.id);

      // 为每个子任务创建 bd issue
      for (const task of tasks) {
        const bdTask = await this.bdTools.createTask({
          title: task.description,
          type: 'task',
          parent: this.context.currentEpicId,
          priority: task.priority,
          labels: task.tools.includes('critical') ? ['main-path'] : ['parallel'],
          acceptance: [`完成: ${task.description}`],
        });
        task.bdTaskId = bdTask.id;
      }

      return {
        success: true,
        tasks,
      };
    } catch (error) {
      await this.bdTools.addComment(this.context.currentEpicId!,
        `[Orchestrator] 拆解失败: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 派发任务给执行者
   */
  async dispatchTask(task: TaskAssignment, executorId: string): Promise<void> {
    if (this.state !== OrchestratorState.dispatching) {
      this.state = OrchestratorState.dispatching;
    }

    // 更新 bd 状态
    if (task.bdTaskId) {
      await this.bdTools.updateStatus(task.bdTaskId, 'in_progress');
      await this.bdTools.addComment(task.bdTaskId, 
        `[Orchestrator] 分配给执行者: ${executorId}`
      );
      await this.bdTools.assignTask(task.bdTaskId, executorId);
    }

    this.context.pendingTasks.push(task);
  }

  /**
   * 处理任务完成反馈
   */
  async onTaskComplete(taskId: string, success: boolean, feedback?: string): Promise<void> {
    const task = this.context.pendingTasks.find(t => t.bdTaskId === taskId);
    if (!task) return;

    if (success) {
      this.context.completedTasks.push(task);
      if (task.bdTaskId) {
        await this.bdTools.closeTask(
          task.bdTaskId,
          '执行成功完成',
          feedback ? [{ type: 'result', content: feedback }] : undefined
        );
      }
    } else {
      this.context.failedTasks.push(task);
      if (task.bdTaskId) {
        await this.bdTools.updateStatus(task.bdTaskId, 'blocked');
        await this.bdTools.addComment(task.bdTaskId, 
          `[Orchestrator] 执行失败: ${feedback || 'Unknown error'}`
        );
      }
    }

    // 从 pending 中移除
    this.context.pendingTasks = this.context.pendingTasks.filter(t => t.bdTaskId !== taskId);

    // 检查是否需要重规划
    if (this.context.failedTasks.length > 0) {
      this.state = OrchestratorState.replanning;
    } else if (this.context.pendingTasks.length === 0 && this.context.failedTasks.length === 0) {
      this.state = OrchestratorState.completing;
    }

    // 更新 Epic 进度
    if (this.context.currentEpicId) {
      await this.updateEpicProgress();
    }
  }

  /**
   * 更新 Epic 进度
   */
  private async updateEpicProgress(): Promise<void> {
    if (!this.context.currentEpicId) return;

    const progress = await this.bdTools.getEpicProgress(this.context.currentEpicId);
    await this.bdTools.addComment(this.context.currentEpicId,
      `[System] Epic 进度: ${progress.completed}/${progress.total} 完成`
    );

    // 如果全部完成，关闭 Epic
    if (progress.completed === progress.total && progress.total > 0) {
      await this.bdTools.closeTask(
        this.context.currentEpicId,
        'Epic 完成',
        [
          { type: 'summary', content: `完成 ${progress.completed} 个子任务` },
          { type: 'stats', content: JSON.stringify(progress) }
        ]
      );
    }
  }

  /**
   * 根据执行者反馈更新计划
   */
  async replan(
    completedTasks: TaskAssignment[],
    failedTasks: TaskAssignment[],
    remainingTasks: TaskAssignment[],
    newRequirements: string
  ): Promise<DecomposeResult> {
    this.state = OrchestratorState.replanning;
    
    const context = `已完成: ${completedTasks.map(t => t.description).join(', ')}
失败: ${failedTasks.map(t => t.description).join(', ')}
剩余: ${remainingTasks.map(t => t.description).join(', ')}
新要求: ${newRequirements}`;

    return this.decomposeTask(context, [], []);
  }

  /**
   * 创建任务分配消息
   */
  createTaskMessage(
    receiver: string,
    task: TaskAssignment
  ): AgentMessage {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      sender: this.config.id,
      receiver,
      mode: 'execute' as MessageMode,
      status: 'pending',
      payload: { task },
    };
  }

  getRole(): string {
    return 'orchestrator';
  }

  getState(): OrchestratorState {
    return this.state;
  }

  getContext(): OrchestratorContext {
    return { ...this.context };
  }

  /**
   * 构建任务拆解提示词
   */
  private buildDecomposePrompt(
    task: string,
    roles: string[],
    tools: string[]
  ): string {
    return `你是一个任务编排专家。请将以下任务拆解为可分配给不同执行者的子任务。

原始任务: ${task}

可用角色: ${roles.join(', ') || '无限制'}
可用工具: ${tools.join(', ') || '无限制'}

请按以下 JSON 格式返回子任务列表:
[
  {
    "taskId": "task-1",
    "description": "子任务描述",
    "tools": ["tool1", "tool2"],
    "priority": 1,
    "thought": "思考过程",
    "action": "具体行动"
  }
]

注意:
1. 每个子任务必须有明确的 description 和 taskId
2. priority 为数字，越小优先级越高
3. tools 为子任务需要的工具列表
4. thought 展示你的思考过程
5. action 展示具体行动`;
  }

  /**
   * 解析 AI 返回的任务分配
   */
  private parseTaskAssignments(content: string, _orchestratorId: string): TaskAssignment[] {
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map((item: Record<string, unknown>) => ({
        taskId: String(item.taskId || ''),
        description: String(item.description || ''),
        tools: Array.isArray(item.tools) ? item.tools.map(String) : [],
        priority: Number(item.priority || 1),
        thought: item.thought ? String(item.thought) : undefined,
        action: item.action ? String(item.action) : undefined,
      }));
    } catch {
      return [];
    }
  }
}
