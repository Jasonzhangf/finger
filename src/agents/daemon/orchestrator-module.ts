/**
 * 真正的编排者模块 - 集成 iFlow SDK + bd 任务管理 + workflow/session
 */

import type { OutputModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { Agent, AgentConfig } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { TaskAssignment } from '../protocol/schema.js';
import { WorkflowManager } from '../../orchestration/workflow-manager.js';
import { SessionManager } from '../../orchestration/session-manager.js';
import { AgentPool, AgentInstance } from '../../orchestration/agent-pool.js';

export interface OrchestratorModuleConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  reviewAgentId?: string;
  summaryAgentId?: string;
}

interface TaskDecomposition {
  taskId: string;
  description: string;
  tools: string[];
  priority: number;
  assignTo?: string;
  deadlineMs?: number;
  dependencies?: string[];
  type?: 'executor' | 'reviewer';
}

interface OrchestrateResult {
  epicId: string;
  workflowId: string;
  sessionId: string;
  totalTasks: number;
  completed: number;
  blocked: number;
  ready: number;
  queue: {
    ready: Array<{ id: string; description: string; assignee?: string }>;
    blocked: Array<{ id: string; description: string; waitingFor: string[] }>;
  };
  resources: {
    executors: number;
    reviewers: number;
    availableExecutors: number;
    availableReviewers: number;
  };
  tasks: Array<{ id?: string; description: string; status: string; assignee?: string }>;
  review: unknown;
  summary: unknown;
}

export function createRealOrchestratorModule(
  config: OrchestratorModuleConfig,
  hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const agentConfig: AgentConfig = {
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt:
      config.systemPrompt ??
      '你是一个任务编排专家。请将用户任务拆解为可执行的子任务，并以JSON格式返回。',
    cwd: config.cwd,
  };

  const agent = new Agent(agentConfig);
  const bdTools = new BdTools();
  const workflowManager = new WorkflowManager();
  const sessionManager = new SessionManager();
  const agentPool = new AgentPool();
  let initialized = false;

  const reviewAgentId = config.reviewAgentId;
  const summaryAgentId = config.summaryAgentId;

  function syncResourcesFromAgentPool(): void {
    const agents = agentPool.getAllInstances();
    const executorAgents = agents
      .filter((a: AgentInstance) => a.status === 'running' && a.config.id.includes('executor'))
      .map((a: AgentInstance) => a.config.id);
    const reviewerAgents = agents
      .filter((a: AgentInstance) => a.status === 'running' && a.config.id.includes('reviewer'))
      .map((a: AgentInstance) => a.config.id);

    for (const id of executorAgents) {
      workflowManager.registerAgent(id, 'executor');
    }
    for (const id of reviewerAgents) {
      workflowManager.registerAgent(id, 'reviewer');
    }

    // Ensure mock executor is always available
    workflowManager.registerAgent('executor-mock', 'executor');
  }

  async function decomposeWithAI(
    userTask: string,
    availableExecutors: string[],
    availableReviewers: string[]
  ): Promise<TaskDecomposition[]> {
    const prompt = `请将以下任务拆解为可执行的子任务列表，并包含依赖关系与资源分配建议。

用户任务: ${userTask}

可用资源:
- executors (${availableExecutors.length}): ${availableExecutors.join(', ') || 'none'}
- reviewers (${availableReviewers.length}): ${availableReviewers.join(', ') || 'none'}

要求:
1. 每个子任务必须可独立执行
2. 必须给出 dependencies（依赖 taskId 数组）
3. 根据依赖区分 ready/blocked 任务
4. priority 必须在 0-4
5. type 必须为 executor 或 reviewer
6. assignTo 优先从可用资源中选择
7. deadlineMs 提供预估执行时间

返回 JSON 数组:
[
  {
    "taskId": "task-1",
    "description": "子任务描述",
    "tools": ["file", "code"],
    "priority": 1,
    "type": "executor",
    "assignTo": "executor-mock",
    "deadlineMs": 60000,
    "dependencies": []
  }
]

只返回 JSON，不要其他文字。`;

    const result = await agent.execute(prompt);
    if (!result.success) {
      throw new Error(`Task decomposition failed: ${result.error}`);
    }

    try {
      const jsonMatch = result.output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in response');
      }
      const parsed = JSON.parse(jsonMatch[0]) as TaskDecomposition[];
      return parsed.map(task => ({
        ...task,
        priority: typeof task.priority === 'number' ? task.priority : 1,
        type: task.type ?? 'executor',
        dependencies: task.dependencies ?? [],
      }));
    } catch (e) {
      console.error('[Orchestrator] Failed to parse decomposition:', result.output);
      throw new Error(`Failed to parse decomposition: ${e}`);
    }
  }

  async function createBdTasks(
    epicId: string,
    decompositions: TaskDecomposition[]
  ): Promise<TaskAssignment[]> {
    const tasks: TaskAssignment[] = [];

    for (const dec of decompositions) {
      const bdTask = await bdTools.createTask({
        title: dec.description,
        description: `子任务: ${dec.description}\n工具: ${dec.tools.join(', ')}\n依赖: ${(dec.dependencies ?? []).join(', ') || '无'}`,
        type: 'task',
        parent: epicId,
        priority: dec.priority,
        labels: (dec.dependencies?.length ?? 0) > 0 ? ['blocked'] : ['ready'],
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
    }

    // add dependency edges in bd
    for (const dec of decompositions) {
      if (!dec.dependencies?.length) continue;
      const current = tasks.find(t => t.taskId === dec.taskId);
      if (!current?.bdTaskId) continue;

      for (const depId of dec.dependencies) {
        const blocker = tasks.find(t => t.taskId === depId);
        if (blocker?.bdTaskId) {
          await bdTools.addDependency(current.bdTaskId, blocker.bdTaskId);
          await bdTools.updateStatus(current.bdTaskId, 'blocked');
        }
      }
    }

    return tasks;
  }

  async function dispatchTask(
    task: TaskAssignment,
    executorId: string,
    workflowId: string
  ): Promise<{ task: TaskAssignment; result: Record<string, unknown> | null; error?: string }> {
    if (task.bdTaskId) {
      await bdTools.updateStatus(task.bdTaskId, 'in_progress');
    }
    workflowManager.assignTask(workflowId, task.taskId, executorId);
    workflowManager.updateTaskStatus(workflowId, task.taskId, 'in_progress');

    const timeoutMs = task.deadline || 60000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Task ${task.taskId} timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      const result = (await Promise.race([
        hub.sendToModule(executorId, {
          taskId: task.taskId,
          bdTaskId: task.bdTaskId,
          description: task.description,
          tools: task.tools,
        }),
        timeoutPromise,
      ])) as Record<string, unknown>;

      if (task.bdTaskId) {
        if (result.success) {
          await bdTools.closeTask(task.bdTaskId, '执行成功', [
            { type: 'result', content: String(result.output || result) },
          ]);
          workflowManager.updateTaskStatus(workflowId, task.taskId, 'completed', result);
        } else {
          await bdTools.updateStatus(task.bdTaskId, 'blocked');
          await bdTools.addComment(task.bdTaskId, `执行失败: ${String(result.error || 'Unknown')}`);
          workflowManager.updateTaskStatus(
            workflowId,
            task.taskId,
            'failed',
            undefined,
            String(result.error || 'Unknown')
          );
        }
      }
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return { task, result };
    } catch (err) {
      if (task.bdTaskId) {
        await bdTools.updateStatus(task.bdTaskId, 'blocked');
        await bdTools.addComment(task.bdTaskId, `派发失败: ${String(err)}`);
      }
      workflowManager.updateTaskStatus(
        workflowId,
        task.taskId,
        'failed',
        undefined,
        err instanceof Error ? err.message : String(err)
      );
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return { task, result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function runSelfReview(epicId: string, tasks: TaskAssignment[], results: unknown[]): Promise<unknown> {
    if (!reviewAgentId) {
      return null;
    }
    await bdTools.addComment(epicId, '[Orchestrator] 启动自审...');
    try {
      return await hub.sendToModule(reviewAgentId, {
        epicId,
        tasks: tasks.map(t => ({ id: t.bdTaskId, description: t.description })),
        results,
      });
    } catch {
      return null;
    }
  }

  async function runSummary(epicId: string, reviewOutput: unknown): Promise<unknown> {
    if (!summaryAgentId) {
      return null;
    }
    await bdTools.addComment(epicId, '[Orchestrator] 生成总结...');
    try {
      return await hub.sendToModule(summaryAgentId, {
        epicId,
        reviewOutput,
      });
    } catch {
      return null;
    }
  }

  function buildQueueState(workflowId: string): {
    ready: Array<{ id: string; description: string; assignee?: string }>;
    blocked: Array<{ id: string; description: string; waitingFor: string[] }>;
  } {
    const workflow = workflowManager.getWorkflow(workflowId);
    if (!workflow) {
      return { ready: [], blocked: [] };
    }

    const ready: Array<{ id: string; description: string; assignee?: string }> = [];
    const blocked: Array<{ id: string; description: string; waitingFor: string[] }> = [];

    for (const task of workflow.tasks.values()) {
      if (task.status === 'ready' || task.status === 'pending') {
        ready.push({ id: task.id, description: task.description, assignee: task.assignee });
      }
      if (task.status === 'blocked') {
        blocked.push({ id: task.id, description: task.description, waitingFor: task.dependencies });
      }
    }

    return { ready, blocked };
  }

  async function orchestrate(userTask: string, sessionId?: string): Promise<OrchestrateResult> {
    syncResourcesFromAgentPool();

    let session = sessionId ? sessionManager.getSession(sessionId) : sessionManager.getCurrentSession();
    if (!session) {
      session = sessionManager.createSession(config.cwd ?? process.cwd(), 'default');
    }

    const epic = await bdTools.createTask({
      title: userTask,
      description: `用户任务: ${userTask}`,
      type: 'epic',
      priority: 0,
      labels: ['orchestration', `session:${session.id}`],
    });

    sessionManager.addMessage(session.id, 'user', userTask);

    const workflow = workflowManager.createWorkflow(session.id, epic.id);
    sessionManager.addWorkflowToSession(session.id, workflow.id);

    await bdTools.addComment(epic.id, `[Orchestrator] 开始编排任务 (session=${session.id}, workflow=${workflow.id})`);

    const availableExecutors = workflowManager.getAvailableAgents('executor');
    const availableReviewers = workflowManager.getAvailableAgents('reviewer');

    const decompositions = await decomposeWithAI(userTask, availableExecutors, availableReviewers);

    for (const dec of decompositions) {
      workflowManager.addTask(workflow.id, {
        id: dec.taskId,
        description: dec.description,
        type: dec.type ?? 'executor',
        dependencies: dec.dependencies ?? [],
        estimatedDuration: dec.deadlineMs,
        deadline: dec.deadlineMs,
      });

      if ((dec.dependencies?.length ?? 0) > 0) {
        workflowManager.updateTaskStatus(workflow.id, dec.taskId, 'blocked');
      } else {
        workflowManager.updateTaskStatus(workflow.id, dec.taskId, 'ready');
      }
    }

    await bdTools.addComment(
      epic.id,
      `[Orchestrator] 拆解完成，共 ${decompositions.length} 个子任务:\n` +
        decompositions.map((d, i) => `${i + 1}. ${d.description}`).join('\n')
    );

    const tasks = await createBdTasks(epic.id, decompositions);

    await bdTools.addComment(epic.id, '[Orchestrator] 开始按依赖执行就绪任务...');

    const allResults: Array<{ task: TaskAssignment; result: Record<string, unknown> | null; error?: string }> = [];
    let guard = 0;

    while (guard < 1000) {
      guard += 1;
      const readyNodes = workflowManager.getReadyTasks(workflow.id);
      if (readyNodes.length === 0) {
        break;
      }

      const availableExec = workflowManager.getAvailableAgents('executor');
      if (availableExec.length === 0) {
        break;
      }

      const batch = readyNodes.slice(0, availableExec.length);
      const dispatchPromises = batch.map((node, idx) => {
        const task = tasks.find(t => t.taskId === node.id);
        if (!task) {
          return Promise.resolve({ task: { taskId: node.id, description: node.description, tools: [], priority: 1 }, result: null, error: 'task-missing' });
        }
        const preferred = decompositions.find(d => d.taskId === node.id)?.assignTo;
        const executorId = preferred && availableExec.includes(preferred) ? preferred : availableExec[idx] || 'executor-mock';
        return dispatchTask(task, executorId, workflow.id);
      });

      const settled = await Promise.allSettled(dispatchPromises);
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          allResults.push(item.value);
        }
      }
    }

    const reviewOutput = await runSelfReview(
      epic.id,
      tasks,
      allResults.filter(r => r.result !== null).map(r => r.result)
    );
    const summaryOutput = await runSummary(epic.id, reviewOutput);

    const progress = await bdTools.getEpicProgress(epic.id);

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
      await bdTools.closeTask(epic.id, '所有子任务已完成', deliverables);
    }

    const queue = buildQueueState(workflow.id);
    const resources = workflowManager.getResourcePool();

    const result: OrchestrateResult = {
      epicId: epic.id,
      workflowId: workflow.id,
      sessionId: session.id,
      totalTasks: tasks.length,
      completed: progress.completed,
      blocked: queue.blocked.length,
      ready: queue.ready.length,
      queue,
      resources: {
        executors: resources.executors.length,
        reviewers: resources.reviewers.length,
        availableExecutors: workflowManager.getAvailableAgents('executor').length,
        availableReviewers: workflowManager.getAvailableAgents('reviewer').length,
      },
      tasks: tasks.map((t) => {
        const node = workflowManager.getWorkflow(workflow.id)?.tasks.get(t.taskId);
        return {
          id: t.bdTaskId,
          description: t.description,
          status: node?.status ?? 'pending',
          assignee: node?.assignee,
        };
      }),
      review: reviewOutput,
      summary: summaryOutput,
    };

    sessionManager.addMessage(session.id, 'orchestrator', JSON.stringify(result));
    return result;
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
      if (!initialized) {
        await agent.initialize();
        initialized = true;
      }

      const msg = message as Record<string, unknown>;
      const userTask = String(msg.content ?? msg.task ?? msg.text ?? '');
      const sessionId = msg.sessionId ? String(msg.sessionId) : undefined;

      if (!userTask) {
        const error = { success: false, error: 'No task content provided' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await orchestrate(userTask, sessionId);
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
