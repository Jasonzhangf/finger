import { Agent, AgentConfig } from '../agent.js';
import { TaskAssignment } from '../protocol/schema.js';
import { BdTools } from '../shared/bd-tools.js';

export interface DecomposeResult {
  success: boolean;
  tasks?: TaskAssignment[];
  error?: string;
}

export interface OrchestratorAgentConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
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

export class OrchestratorRoleRefactored {
  private config: OrchestratorAgentConfig;
  private agent: Agent;
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

  constructor(config: OrchestratorAgentConfig) {
    this.config = config;
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name,
      mode: config.mode,
      provider: 'iflow',
      systemPrompt: config.systemPrompt ?? this.getDefaultSystemPrompt(),
      cwd: config.cwd,
      resumeSession: true,
    };
    this.agent = new Agent(agentConfig);
    this.bdTools = new BdTools(config.cwd);
  }

  private getDefaultSystemPrompt(): string {
    return `你是一个任务编排专家。请将用户任务拆解为可执行的子任务。

你的职责：
1. 理解用户任务意图
2. 识别任务依赖关系（阻塞/并行）
3. 为每个子任务分配角色（executor/reviewer）
4. 返回结构化的任务列表

输出格式（JSON）：
{
  "tasks": [
    {
      "taskId": "task-1",
      "description": "子任务描述",
      "role": "executor",
      "tools": ["file.read", "shell.exec"],
      "priority": 1,
      "order": 1,
      "blockedBy": [],
      "thought": "为什么创建这个子任务"
    }
  ],
  "flow": "并行/串行/混合",
  "notes": "任务执行说明"
}`;
  }

  async initialize(): Promise<void> {
    await this.agent.initialize();
  }

  async disconnect(): Promise<void> {
    await this.agent.disconnect();
  }

  /** 启动编排会话 */
  async startOrchestration(userTask: string): Promise<string> {
    this.context.originalTask = userTask;

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

  /** 理解任务意图 */
  async understandTask(task: string): Promise<{
    understood: boolean;
    needsClarification: boolean;
    questions?: string[];
    summary?: string;
  }> {
    this.state = OrchestratorState.understanding;

    const understandPrompt = `请分析以下任务，判断是否需要进一步澄清：

任务：${task}

请返回 JSON 格式：
{
  "understood": true/false,
  "needsClarification": true/false,
  "questions": ["如果需要澄清，列出问题"],
  "summary": "对任务的理解摘要"
}`;

    const result = await this.agent.execute(understandPrompt) ?? { success: false, output: "", error: "Agent returned undefined" };
    if (!result.success) {
      throw new Error('Task understanding failed: ' + result.error);
    }

    try {
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // Return basic understood response
    }

    return { understood: true, needsClarification: false, summary: result.output };
  }

  /** 编排者核心方法：拆解任务 */
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
      const result = await this.agent.execute(prompt) ?? { success: false, output: "", error: "Agent returned undefined" };
      if (!result.success) {
        throw new Error(result.error || 'Decomposition failed');
      }

      const tasks = this.parseTaskAssignments(result.output);

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

      this.context.currentPlan = tasks;

      return { success: true, tasks };
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

  /** 派发任务 */
  async dispatchTask(task: TaskAssignment, executorId: string): Promise<void> {
    if (this.state !== OrchestratorState.dispatching) {
      this.state = OrchestratorState.dispatching;
    }

    if (task.bdTaskId) {
      await this.bdTools.updateStatus(task.bdTaskId, 'in_progress');
      await this.bdTools.addComment(task.bdTaskId,
        `[Orchestrator] 分配给执行者: ${executorId}`
      );
      await this.bdTools.assignTask(task.bdTaskId, executorId);
    }

    this.context.pendingTasks.push(task);
  }

  /** 处理任务完成反馈 */
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

    this.context.pendingTasks = this.context.pendingTasks.filter(t => t.bdTaskId !== taskId);

    if (this.context.failedTasks.length > 0) {
      this.state = OrchestratorState.replanning;
    } else if (this.context.pendingTasks.length === 0 && this.context.failedTasks.length === 0) {
      this.state = OrchestratorState.completing;
    }

    if (this.context.currentEpicId) {
      await this.updateEpicProgress();
    }
  }

  /** 根据反馈更新计划 */
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

  getState(): OrchestratorState {
    return this.state;
  }

  getContext(): OrchestratorContext {
    return { ...this.context };
  }

  private buildDecomposePrompt(
    task: string,
    roles: string[],
    tools: string[]
  ): string {
    return `请将以下任务拆解为可执行的子任务：

原始任务: ${task}

可用角色: ${roles.join(', ') || '无限制'}
可用工具: ${tools.join(', ') || '无限制'}

请返回 JSON 格式，包含 tasks 数组，每个任务需有 taskId、description、role、tools、priority、order、blockedBy 字段。`;
  }

  private parseTaskAssignments(content: string): TaskAssignment[] {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      const tasks = parsed.tasks || parsed;

      if (!Array.isArray(tasks)) return [];

      return tasks.map((item: Record<string, unknown>) => ({
        taskId: String(item.taskId || ''),
        description: String(item.description || ''),
        role: String(item.role || 'executor'),
        tools: Array.isArray(item.tools) ? item.tools.map(String) : [],
        priority: Number(item.priority || 1),
        order: Number(item.order || 1),
        blockedBy: Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : [],
        thought: item.thought ? String(item.thought) : undefined,
      }));
    } catch {
      return [];
    }
  }

  private async updateEpicProgress(): Promise<void> {
    if (!this.context.currentEpicId) return;

    const progress = await this.bdTools.getEpicProgress(this.context.currentEpicId);
    await this.bdTools.addComment(this.context.currentEpicId,
      `[System] Epic 进度: ${progress.completed}/${progress.total} 完成`
    );

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
}
