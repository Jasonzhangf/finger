/**
 * 真正的编排者模块 - 集成 iFlow SDK + bd 任务管理
 */

import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { TaskAssignment } from '../protocol/schema.js';

export interface OrchestratorModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  reviewAgentId?: string;   // 自审 Agent ID
  summaryAgentId?: string;  // 总结 Agent ID
}

interface TaskDecomposition {
  taskId: string;
  description: string;
  tools: string[];
  priority: number;
  assignTo?: string;
  deadlineMs?: number;      // 任务执行超时（毫秒）
}

/**
 * 创建真正的编排者模块
 */
export function createRealOrchestratorModule(
  config: OrchestratorModuleConfig,
  hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: config.systemPrompt ?? '你是一个任务编排专家。请将用户任务拆解为可执行的子任务，并以JSON格式返回。',
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  const bdTools = new BdTools();
  let initialized = false;
  const reviewAgentId = config.reviewAgentId;
  const summaryAgentId = config.summaryAgentId;

  /**
   * 使用 iFlow SDK 拆解任务
   */
  async function decomposeWithAI(userTask: string): Promise<TaskDecomposition[]> {
    const prompt = `请将以下任务拆解为可执行的子任务列表。

用户任务: ${userTask}

要求:
1. 每个子任务必须是可独立执行的
2. 按依赖顺序排列
3. 标记关键路径任务
4. 为每个子任务分配合理的超时时间（毫秒），基于任务复杂度，默认 60000

请按以下JSON格式返回:
[
  {
    "taskId": "task-1",
    "description": "子任务描述",
    "tools": ["file", "code"],
    "priority": 1,
    "assignTo": "executor-mock",
    "deadlineMs": 60000
  }
]

只返回JSON数组，不要有其他文字。`;

    const result = await agent.execute(prompt);
    
    if (!result.success) {
      throw new Error(`Task decomposition failed: ${result.error}`);
    }

    try {
      const jsonMatch = result.output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[Orchestrator] Failed to parse decomposition:', result.output);
      throw new Error(`Failed to parse decomposition: ${e}`);
    }
  }

  /**
   * 创建 bd 子任务
   */
  async function createBdTasks(
    epicId: string,
    decompositions: TaskDecomposition[]
  ): Promise<TaskAssignment[]> {
    const tasks: TaskAssignment[] = [];

    for (const dec of decompositions) {
      const bdTask = await bdTools.createTask({
        title: dec.description,
        description: `子任务: ${dec.description}\n工具: ${dec.tools.join(', ')}`,
        type: 'task',
        parent: epicId,
        priority: dec.priority,
        labels: dec.tools.includes('critical') ? ['main-path'] : ['parallel'],
        assignee: dec.assignTo,
      });

      tasks.push({
        taskId: dec.taskId,
        bdTaskId: bdTask.id,
        description: dec.description,
        tools: dec.tools,
        priority: dec.priority,
        deadline: dec.deadlineMs,
      });

      console.log(`[Orchestrator] Created sub-task: ${bdTask.id} -> ${dec.description}`);
    }

    return tasks;
  }

  /**
   * 派发任务给 executor
   */
  async function dispatchTask(
    task: TaskAssignment,
    executorId: string
  ): Promise<{ task: TaskAssignment; result: any; error?: string }> {
    if (task.bdTaskId) {
      await bdTools.updateStatus(task.bdTaskId, 'in_progress');
    }

    const timeoutMs = task.deadline || 60000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Task ${task.taskId} timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = await Promise.race([
        hub.sendToModule(executorId, {
          taskId: task.taskId,
          bdTaskId: task.bdTaskId,
          description: task.description,
          tools: task.tools,
        }),
        timeoutPromise,
      ]);

      console.log(`[Orchestrator] Task ${task.taskId} result:`, result);

      if (task.bdTaskId) {
        if (result.success) {
          await bdTools.closeTask(task.bdTaskId, '执行成功', [
            { type: 'result', content: String(result.output || result) },
          ]);
        } else {
          await bdTools.updateStatus(task.bdTaskId, 'blocked');
          await bdTools.addComment(task.bdTaskId, `执行失败: ${result.error || 'Unknown'}`);
        }
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return { task, result };
    } catch (err) {
      console.error(`[Orchestrator] Task ${task.taskId} failed:`, err);
      if (task.bdTaskId) {
        await bdTools.updateStatus(task.bdTaskId, 'blocked');
        await bdTools.addComment(task.bdTaskId, `派发失败: ${err}`);
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return { task, result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 调用自审 Agent
   */
  async function runSelfReview(epicId: string, tasks: TaskAssignment[], results: any[]): Promise<any> {
    if (!reviewAgentId) {
      console.log('[Orchestrator] No self-review agent configured, skipping review');
      return null;
    }
    console.log(`[Orchestrator] Running self-review via ${reviewAgentId}...`);
    await bdTools.addComment(epicId, `[Orchestrator] 启动自审...`);
    try {
      const reviewResult = await hub.sendToModule(reviewAgentId, {
        epicId,
        tasks: tasks.map(t => ({ id: t.bdTaskId, description: t.description })),
        results,
      });
      console.log('[Orchestrator] Self-review completed:', reviewResult);
      return reviewResult;
    } catch (err) {
      console.error('[Orchestrator] Self-review failed:', err);
      return null;
    }
  }

  /**
   * 调用总结 Agent
   */
  async function runSummary(epicId: string, reviewOutput: any): Promise<any> {
    if (!summaryAgentId) {
      console.log('[Orchestrator] No summary agent configured, skipping summary');
      return null;
    }
    console.log(`[Orchestrator] Running summary via ${summaryAgentId}...`);
    await bdTools.addComment(epicId, `[Orchestrator] 生成总结...`);
    try {
      const summaryResult = await hub.sendToModule(summaryAgentId, {
        epicId,
        reviewOutput,
      });
      console.log('[Orchestrator] Summary completed:', summaryResult);
      return summaryResult;
    } catch (err) {
      console.error('[Orchestrator] Summary failed:', err);
      return null;
    }
  }

  /**
   * 执行完整编排流程
   */
  async function orchestrate(userTask: string): Promise<any> {
    console.log(`[Orchestrator] Starting orchestration: ${userTask}`);

    // 1. 创建 Epic
    const epic = await bdTools.createTask({
      title: userTask,
      description: `用户任务: ${userTask}`,
      type: 'epic',
      priority: 0,
      labels: ['orchestration'],
    });
    console.log(`[Orchestrator] Created Epic: ${epic.id}`);

    await bdTools.addComment(epic.id, `[Orchestrator] 开始编排任务`);

    // 2. 拆解任务
    await bdTools.addComment(epic.id, `[Orchestrator] 使用 AI 拆解任务...`);
    const decompositions = await decomposeWithAI(userTask);
    console.log(`[Orchestrator] Decomposed into ${decompositions.length} sub-tasks`);

    await bdTools.addComment(
      epic.id,
      `[Orchestrator] 拆解完成，共 ${decompositions.length} 个子任务:\n` +
        decompositions.map((d, i) => `${i + 1}. ${d.description}`).join('\n')
    );

    // 3. 创建 bd 子任务
    const tasks = await createBdTasks(epic.id, decompositions);

    // 4. 并行派发任务
    await bdTools.addComment(epic.id, `[Orchestrator] 开始派发任务...`);

    const dispatchPromises = tasks.map(task => {
      const executorId = decompositions.find(d => d.taskId === task.taskId)?.assignTo || 'executor-mock';
      return dispatchTask(task, executorId);
    });

    const settledResults = await Promise.allSettled(dispatchPromises);
    const successResults = [];
    const failedTasks = [];

    for (let i = 0; i < settledResults.length; i++) {
      const res = settledResults[i];
      const task = tasks[i];
      if (res.status === 'fulfilled') {
        successResults.push(res.value);
      } else {
        failedTasks.push({ task, reason: res.reason });
        if (task.bdTaskId) {
          await bdTools.updateStatus(task.bdTaskId, 'blocked');
          await bdTools.addComment(task.bdTaskId, `派发失败: ${res.reason}`);
        }
      }
    }

    // 5. 运行自审（如果配置了）
    const reviewOutput = await runSelfReview(epic.id, tasks, successResults);

    // 6. 运行总结（如果配置了）
    const summaryOutput = await runSummary(epic.id, reviewOutput);

    // 7. 更新 Epic 进度并尝试关闭
    const progress = await bdTools.getEpicProgress(epic.id);
    console.log(`[Orchestrator] Epic progress: ${progress.completed}/${progress.total}`);

    // Prepare deliverables with proper typing
    const deliverables: { type: 'summary' | 'review'; content: string }[] = [
      { type: 'summary', content: `完成 ${progress.completed} 个子任务` },
    ];
    if (reviewOutput) {
      deliverables.push({ type: 'review', content: JSON.stringify(reviewOutput) });
    }
    if (summaryOutput) {
      deliverables.push({ type: 'summary', content: JSON.stringify(summaryOutput) });
    }

    if (progress.completed === progress.total && progress.completed > 0) {
      await bdTools.closeTask(
        epic.id,
        '所有子任务已完成',
        deliverables
      );
      console.log(`[Orchestrator] Epic ${epic.id} closed`);
    } else {
      // 如果未完成，添加注释说明失败任务
      if (failedTasks.length > 0) {
        await bdTools.addComment(epic.id, `[Orchestrator] 有 ${failedTasks.length} 个子任务失败: ${failedTasks.map(f => f.task.description).join(', ')}`);
      }
    }

    return {
      epicId: epic.id,
      totalTasks: tasks.length,
      completed: progress.completed,
      tasks: tasks.map((t) => ({ id: t.bdTaskId, description: t.description })),
      review: reviewOutput,
      summary: summaryOutput,
    };
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'orchestrator' },

    initialize: async () => {
      if (initialized) return;
      const status = await agent.initialize();
      console.log(`[OrchestratorModule ${config.id}] Initialized, session: ${status.sessionId}`);
      initialized = true;
    },

    destroy: async () => {
      await agent.disconnect();
      initialized = false;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      // Ensure agent is initialized before handling
      if (!initialized) {
        await agent.initialize();
        initialized = true;
      }
      
      const msg = message as Record<string, unknown>;
      const userTask = String(msg.content ?? msg.task ?? msg.text ?? '');

      if (!userTask) {
        const error = { success: false, error: 'No task content provided' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await orchestrate(userTask);
        if (callback) callback({ success: true, result });
        return { success: true, result };
      } catch (err) {
        const error = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        if (callback) callback(error);
        return error;
      }
    },
  };

  return { agent, module };
}
