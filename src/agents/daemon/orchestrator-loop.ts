/**
 * 编排者 ReACT 循环 - 最小闭环实现
 */

import { Agent } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { MessageHub } from '../../orchestration/message-hub.js';
import type { OutputModule } from '../../orchestration/module-registry.js';

export interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  error?: string;
}

export interface TaskNode {
  id: string;
  description: string;
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed';
  assignee?: string;
  result?: TaskResult;
  bdTaskId?: string;
}

export interface OrchestrationState {
  phase: 'understanding' | 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed';
  userTask: string;
  taskGraph: TaskNode[];
  completedTasks: string[];
  failedTasks: string[];
  round: number;
}

export interface OrchestratorLoopConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  maxRounds?: number;
}

export function createOrchestratorLoop(
  config: OrchestratorLoopConfig,
  hub: MessageHub
): { agent: Agent; module: OutputModule } {
  
  const systemPrompt = config.systemPrompt ?? `你是一个任务编排专家...`;

  const agent = new Agent({
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt,
    cwd: config.cwd,
    resumeSession: true,
  });

  const bdTools = new BdTools(config.cwd);
  let initialized = false;

  function buildStatePrompt(state: OrchestrationState): string {
    return `
## 当前编排状态
阶段: ${state.phase}
回合: ${state.round}/${config.maxRounds ?? 10}

任务图谱:
${state.taskGraph.map((t: TaskNode) => 
  `- ${t.id}: ${t.description} [${t.status}]${t.assignee ? ` @${t.assignee}` : ''}${t.result ? ` → ${t.result.success ? '✓' : '✗'}` : ''}`
).join('\n')}

已完成: ${state.completedTasks.join(', ') || '无'}
失败: ${state.failedTasks.join(', ') || '无'}

## 用户原始任务
${state.userTask}

请返回 JSON 格式的决策。`;
  }

  async function reactLoop(userTask: string): Promise<unknown> {
    const state: OrchestrationState = {
      phase: 'understanding',
      userTask,
      taskGraph: [],
      completedTasks: [],
      failedTasks: [],
      round: 0,
    };

    const epic = await bdTools.createTask({
      title: userTask,
      type: 'epic',
      priority: 0,
      labels: ['orchestration', 'react-loop'],
    });

    await bdTools.addComment(epic.id, `[Orchestrator] 启动 ReACT 循环`);

    const maxRounds = config.maxRounds ?? 10;

    while (state.round < maxRounds) {
      state.round++;
      
      const statePrompt = buildStatePrompt(state);
      
      const decision = await agent.execute(statePrompt, {
        onAssistantChunk: (chunk) => process.stdout.write(chunk),
      });

      if (!decision.success) {
        state.phase = 'failed';
        break;
      }

      let action: { thought: string; action: string; taskId?: string; assignee?: string; output?: string };
      try {
        const jsonMatch = decision.output.match(/\{[\s\S]*\}/);
        action = jsonMatch ? JSON.parse(jsonMatch[0]) : { action: 'FAIL', thought: 'Parse error' };
      } catch {
        action = { action: 'FAIL', thought: 'Invalid JSON response' };
      }

      console.log(`[Orchestrator] Action: ${action.action}`);
      await bdTools.addComment(epic.id, `[Round ${state.round}] ${action.action}: ${action.thought}`);

      switch (action.action) {
        case 'PLAN': {
          const plan = await agent.execute(`拆解任务: ${userTask}`);
          if (plan.success) {
            try {
              const tasks = JSON.parse(plan.output.match(/\[[\s\S]*\]/)?.[0] || '[]');
              state.taskGraph = tasks.map((t: { id: string; description: string }) => ({
                id: t.id,
                description: t.description,
                status: 'ready' as const,
              }));
              state.phase = 'executing';
              
              for (const task of state.taskGraph) {
                const bdTask = await bdTools.createTask({
                  title: task.description,
                  type: 'task',
                  parent: epic.id,
                  priority: 1,
                });
                task.bdTaskId = bdTask.id;
              }
            } catch (e) {
              console.error('[Orchestrator] Plan parse error:', e);
            }
          }
          break;
        }

        case 'DISPATCH': {
          const task = state.taskGraph.find((t: TaskNode) => t.id === action.taskId);
          if (task && task.status === 'ready') {
            task.status = 'in_progress';
            task.assignee = action.assignee || 'executor-loop';
            
            await bdTools.updateStatus(task.bdTaskId!, 'in_progress');
            
            const result = await hub.sendToModule(task.assignee, {
              taskId: task.id,
              description: task.description,
              bdTaskId: task.bdTaskId,
            });

            task.result = {
              taskId: task.id,
              success: result.success !== false,
              output: result.output || result.result,
              error: result.error,
            };

            if (task.result.success) {
              task.status = 'completed';
              state.completedTasks.push(task.id);
              await bdTools.closeTask(task.bdTaskId!, '执行成功', [{ type: 'result', content: task.result.output }]);
            } else {
              task.status = 'failed';
              state.failedTasks.push(task.id);
              await bdTools.updateStatus(task.bdTaskId!, 'blocked');
            }
          }
          break;
        }

        case 'COMPLETE': {
          state.phase = 'completed';
          await bdTools.closeTask(epic.id, '所有任务完成');
          return { success: true, epicId: epic.id, completed: state.completedTasks.length, failed: state.failedTasks.length, rounds: state.round, output: action.output };
        }

        case 'FAIL': {
          state.phase = 'failed';
          await bdTools.closeTask(epic.id, '编排失败');
          return { success: false, epicId: epic.id, error: action.thought, rounds: state.round };
        }
      }

      // 自动派发 ready 任务
      const readyTask = state.taskGraph.find((t: TaskNode) => t.status === 'ready');
      if (readyTask && action.action !== 'DISPATCH') {
        readyTask.status = 'in_progress';
        readyTask.assignee = 'executor-loop';
        const result = await hub.sendToModule('executor-loop', { taskId: readyTask.id, description: readyTask.description });
        readyTask.result = { taskId: readyTask.id, success: result.success !== false, output: result.output || result.result, error: result.error };
        readyTask.status = readyTask.result.success ? 'completed' : 'failed';
        if (readyTask.result.success) state.completedTasks.push(readyTask.id);
        else state.failedTasks.push(readyTask.id);
      }

      const allDone = state.taskGraph.length > 0 && state.taskGraph.every((t: TaskNode) => t.status === 'completed' || t.status === 'failed');
      if (allDone && state.failedTasks.length === 0) {
        state.phase = 'completed';
        await bdTools.closeTask(epic.id, '所有任务完成');
        return { success: true, epicId: epic.id, completed: state.completedTasks.length, failed: 0, rounds: state.round };
      }
    }

    return { success: false, epicId: epic.id, error: 'Exceeded maximum rounds', rounds: state.round };
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'orchestrator-loop' },

    initialize: async () => {
      if (initialized) return;
      const status = await agent.initialize();
      console.log(`[OrchestratorLoop ${config.id}] Initialized, session: ${status.sessionId}`);
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

      if (!userTask) {
        const error = { success: false, error: 'No task content provided' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await reactLoop(userTask);
        if (callback) callback({ success: true, result });
        return { success: true, result };
      } catch (err) {
        const error = { success: false, error: err instanceof Error ? err.message : String(err) };
        if (callback) callback(error);
        return error;
      }
    },
  };

  return { agent, module };
}
