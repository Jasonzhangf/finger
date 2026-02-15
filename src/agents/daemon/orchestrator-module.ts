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
}

interface TaskDecomposition {
  taskId: string;
  description: string;
  tools: string[];
  priority: number;
  assignTo?: string;
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

请按以下JSON格式返回:
[
  {
    "taskId": "task-1",
    "description": "子任务描述",
    "tools": ["file", "code"],
    "priority": 1,
    "assignTo": "executor-mock"
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
  ): Promise<void> {
    if (task.bdTaskId) {
      await bdTools.updateStatus(task.bdTaskId, 'in_progress');
    }

    try {
      const result = await hub.sendToModule(executorId, {
        taskId: task.taskId,
        bdTaskId: task.bdTaskId,
        description: task.description,
        tools: task.tools,
      });

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
    } catch (err) {
      console.error(`[Orchestrator] Task ${task.taskId} failed:`, err);
      if (task.bdTaskId) {
        await bdTools.updateStatus(task.bdTaskId, 'blocked');
        await bdTools.addComment(task.bdTaskId, `派发失败: ${err}`);
      }
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

    // 4. 派发任务
    await bdTools.addComment(epic.id, `[Orchestrator] 开始派发任务...`);
    for (const task of tasks) {
      const executorId = decompositions.find((d) => d.taskId === task.taskId)?.assignTo || 'executor-mock';
      await dispatchTask(task, executorId);
    }

    // 5. 更新 Epic 进度并关闭
    const progress = await bdTools.getEpicProgress(epic.id);
    console.log(`[Orchestrator] Epic progress: ${progress.completed}/${progress.total}`);

    if (progress.completed === progress.total) {
      await bdTools.closeTask(
        epic.id,
        '所有子任务已完成',
        [
          { type: 'summary', content: `完成 ${progress.completed} 个子任务` },
        ]
      );
      console.log(`[Orchestrator] Epic ${epic.id} closed`);
    }

    return {
      epicId: epic.id,
      totalTasks: tasks.length,
      completed: progress.completed,
      tasks: tasks.map((t) => ({ id: t.bdTaskId, description: t.description })),
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
