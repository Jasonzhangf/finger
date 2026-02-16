/**
 * 编排者 ReACT 循环 - 最小闭环实现
 */

import { Agent } from '../agent.js';
import { BdTools } from '../shared/bd-tools.js';
import { createSnapshotLogger, SnapshotLogger } from '../shared/snapshot-logger.js';
import { MessageHub } from '../../orchestration/message-hub.js';
import type { OutputModule } from '../../orchestration/module-registry.js';

export interface TaskNode {
  id: string;
  description: string;
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed';
  assignee?: string;
  result?: { taskId: string; success: boolean; output?: string; error?: string };
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
  const systemPrompt = config.systemPrompt ?? `
你是一个任务编排专家。

## 可用行动

- PLAN: 拆解任务，返回 JSON 数组 [{ "id": "task-1", "description": "描述" }]
- COMPLETE: 任务完成，输出结果
- FAIL: 任务失败

## 输出格式（必须严格遵循）

只输出 JSON：
{"thought": "分析", "action": "PLAN|COMPLETE|FAIL", "output": "结果说明"}

示例：
{"thought": "需要创建文件", "action": "PLAN", "output": "拆解为子任务"}`;

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
  const logger: SnapshotLogger = createSnapshotLogger(config.id);
  let initialized = false;

  function buildStatePrompt(state: OrchestrationState): string {
    return `## 当前状态
阶段: ${state.phase}
回合: ${state.round}/${config.maxRounds ?? 10}

任务列表:
${state.taskGraph.length > 0 
  ? state.taskGraph.map((t: TaskNode) => `- ${t.id}: ${t.description} [${t.status}]`).join('\n')
  : '暂无'}

已完成: ${state.completedTasks.join(', ') || '无'}
失败: ${state.failedTasks.join(', ') || '无'}

## 用户任务
${state.userTask}

请立即输出 JSON 格式的决策（只输出 JSON）：`;
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

    const startTime = Date.now();
    console.log(`[OrchestratorLoop ${config.id}] Starting: ${userTask.substring(0, 50)}...`);

    logger.log({
      timestamp: new Date().toISOString(),
      iteration: 0,
      phase: 'start',
      input: { userTask },
      output: null,
    });

    const epic = await bdTools.createTask({
      title: userTask.substring(0, 100),
      type: 'epic',
      priority: 0,
      labels: ['orchestration', 'react-loop'],
    });

    await bdTools.addComment(epic.id, `[OrchestratorLoop] 启动`);

    const maxRounds = config.maxRounds ?? 10;

    while (state.round < maxRounds) {
      state.round++;
      const iterStart = Date.now();

      // THOUGHT
      const statePrompt = buildStatePrompt(state);
      console.log(`[OrchestratorLoop ${config.id}] Round ${state.round}: ${state.phase}`);

      const decision = await agent.execute(statePrompt, {
        onAssistantChunk: (chunk) => process.stdout.write(chunk),
      });

      if (!decision.success) {
        console.error(`[OrchestratorLoop ${config.id}] Decision failed:`, decision.error);
        state.phase = 'failed';
        logger.log({
          timestamp: new Date().toISOString(),
          iteration: state.round,
          phase: 'decision_failed',
          input: statePrompt,
          output: decision,
          error: decision.error,
        });
        break;
      }

      logger.log({
        timestamp: new Date().toISOString(),
        iteration: state.round,
        phase: 'thought',
        input: statePrompt,
        output: decision.output,
        duration: Date.now() - iterStart,
      });

      // Parse action
      let action: { thought: string; action: string; output?: string };
      try {
        const jsonMatch = decision.output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in response');
        action = JSON.parse(jsonMatch[0]);
        console.log(`[OrchestratorLoop ${config.id}] Action: ${action.action}`);
      } catch (e) {
        console.error(`[OrchestratorLoop ${config.id}] Parse error:`, e);
        console.error(`[OrchestratorLoop ${config.id}] Raw:`, decision.output.substring(0, 500));
        action = { action: 'FAIL', thought: 'Parse error' };
      }

      // ACTION
      switch (action.action) {
        case 'PLAN': {
          const planPrompt = `拆解任务: ${userTask}\n\n返回 JSON 数组: [{"id": "task-1", "description": "描述"}]`;
          const plan = await agent.execute(planPrompt);
          
          logger.log({
            timestamp: new Date().toISOString(),
            iteration: state.round,
            phase: 'plan',
            input: planPrompt,
            output: plan.output,
          });

          if (plan.success) {
            try {
              const jsonMatch = plan.output.match(/\[[\s\S]*\]/);
              const tasks = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
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

              await bdTools.addComment(epic.id, `拆解完成: ${state.taskGraph.length} 个任务`);
            } catch (e) {
              console.error(`[OrchestratorLoop ${config.id}] Plan parse error:`, e);
            }
          }
          break;
        }

        case 'COMPLETE': {
          state.phase = 'completed';
          await bdTools.closeTask(epic.id, '完成');
          
          logger.log({
            timestamp: new Date().toISOString(),
            iteration: state.round,
            phase: 'complete',
            input: null,
            output: action.output,
            duration: Date.now() - startTime,
          });

          return {
            success: true,
            epicId: epic.id,
            completed: state.completedTasks.length,
            failed: state.failedTasks.length,
            rounds: state.round,
            output: action.output,
          };
        }

        case 'FAIL': {
          state.phase = 'failed';
          await bdTools.closeTask(epic.id, '失败');
          return { success: false, epicId: epic.id, error: action.thought, rounds: state.round };
        }
      }

      // Auto-dispatch ready tasks
      const readyTask = state.taskGraph.find((t: TaskNode) => t.status === 'ready');
      if (readyTask) {
        readyTask.status = 'in_progress';
        readyTask.assignee = 'executor-loop';

        console.log(`[OrchestratorLoop ${config.id}] Dispatching: ${readyTask.id}`);
        
        const result = await hub.sendToModule('executor-loop', {
          taskId: readyTask.id,
          description: readyTask.description,
          bdTaskId: readyTask.bdTaskId,
        });

        readyTask.result = {
          taskId: readyTask.id,
          success: result.success !== false,
          output: result.output || result.result,
          error: result.error,
        };

        logger.log({
          timestamp: new Date().toISOString(),
          iteration: state.round,
          phase: 'dispatch',
          input: { taskId: readyTask.id, description: readyTask.description },
          output: readyTask.result,
        });

        if (readyTask.result.success) {
          readyTask.status = 'completed';
          state.completedTasks.push(readyTask.id);
        } else {
          readyTask.status = 'failed';
          state.failedTasks.push(readyTask.id);
        }
      }

      // Check completion
      const allDone = state.taskGraph.length > 0 &&
        state.taskGraph.every((t: TaskNode) => t.status === 'completed' || t.status === 'failed');

      if (allDone) {
        state.phase = state.failedTasks.length === 0 ? 'completed' : 'failed';
        await bdTools.closeTask(epic.id, state.phase === 'completed' ? '所有任务完成' : '部分任务失败');
        
        return {
          success: state.failedTasks.length === 0,
          epicId: epic.id,
          completed: state.completedTasks.length,
          failed: state.failedTasks.length,
          rounds: state.round,
        };
      }
    }

    return { success: false, epicId: epic.id, error: 'Exceeded max rounds', rounds: state.round };
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
        const error = { success: false, error: 'No task content' };
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
