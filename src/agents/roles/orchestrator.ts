import { IFlowProvider } from '../providers/iflow-provider.js';
import { AgentMessage, TaskAssignment, MessageMode } from '../protocol/schema.js';

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

export class OrchestratorRole {
  private config: AgentConfig;
  private provider: IFlowProvider;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = new IFlowProvider(config.provider);
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
    const prompt = this.buildDecomposePrompt(originalTask, availableRoles, availableTools);

    try {
      const response = await this.provider.request(prompt, {
        systemPrompt: this.config.systemPrompt,
      });

      const tasks = this.parseTaskAssignments(response, this.config.id);

      return {
        success: true,
        tasks,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
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

  /**
   * 根据执行者反馈更新计划
   */
  async replan(
    completedTasks: TaskAssignment[],
    failedTasks: TaskAssignment[],
    remainingTasks: TaskAssignment[],
    newRequirements: string
  ): Promise<DecomposeResult> {
    const context = `已完成: ${completedTasks.map(t => t.description).join(', ')}
失败: ${failedTasks.map(t => t.description).join(', ')}
剩余: ${remainingTasks.map(t => t.description).join(', ')}
新要求: ${newRequirements}`;

    return this.decomposeTask(context, [], []);
  }

  getRole(): string {
    return 'orchestrator';
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
