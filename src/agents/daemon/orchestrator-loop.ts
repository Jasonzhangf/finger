/**
 * 编排者 ReACT 循环 - 基于通用 ReACT Loop
 * 无硬编码 switch/case
 */

import { Agent } from '../agent.js';
import { ReviewerRole } from '../roles/reviewer.js';
import { BdTools } from '../shared/bd-tools.js';
import { createSnapshotLogger, SnapshotLogger } from '../shared/snapshot-logger.js';
import { MessageHub } from '../../orchestration/message-hub.js';
import { globalEventBus } from '../../runtime/event-bus.js';
import { runtimeInstructionBus } from '../../orchestration/runtime-instruction-bus.js';

import type { OutputModule } from '../../orchestration/module-registry.js';
import {
  ActionRegistry,
  createOrchestratorActions,
  type ActionResult,
} from '../core/action-registry-simple.js';
import {
  ReActLoop,
  type LoopConfig,
  type ReActResult,
  type ReActState,
} from '../runtime/react-loop.js';

export interface TaskNode {
  id: string;
  description: string;
  status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed';
  assignee?: string;
  result?: { taskId: string; success: boolean; output?: string; error?: string };
  bdTaskId?: string;
}

export interface OrchestratorLoopConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  cwd?: string;
  maxRounds?: number;
  enableReview?: boolean;
  targetExecutorId?: string;
  sessionId?: string;
}

type OrchestratorPhase =
  | 'planning'
  | 'high_design'
  | 'detail_design'
  | 'task_allocation'
  | 'execution'
  | 'review'
  | 'completed'
  | 'failed';

type CheckpointTrigger = 'reentry' | 'task_failure';

interface CheckpointState {
  totalChecks: number;
  lastTrigger?: CheckpointTrigger;
  lastCheckAt?: string;
  majorChange: boolean;
}


interface LoopState extends ReActState {
  epicId: string;
  userTask: string;
  taskGraph: TaskNode[];
  completedTasks: string[];
  failedTasks: string[];
  phase: OrchestratorPhase;
  blockedTasks: string[];
  recoveryPointTaskId?: string;
  lastError?: string;
  checkpoint: CheckpointState;
  round: number;
  hub: MessageHub;
  targetExecutorId: string;
}

export function createOrchestratorLoop(
  config: OrchestratorLoopConfig,
  hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const systemPrompt = config.systemPrompt ?? `
你是一个任务编排专家。职责是把用户任务拆成子任务并调度执行。

必须输出 JSON：{"thought":"...","action":"PLAN|DISPATCH|COMPLETE|FAIL","params":{...}}
`;

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
  let initPromise: Promise<void> | null = null;
  let disconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  const registry = new ActionRegistry();
  const baseActions = createOrchestratorActions();
  
  // 延迟断开，避免频繁重连
  const scheduleDisconnect = () => {
    if (disconnectTimeout) {
      clearTimeout(disconnectTimeout);
    }
    disconnectTimeout = setTimeout(async () => {
      if (initialized) {
        console.log('[OrchestratorLoop] Disconnecting due to inactivity');
        try {
          await agent.disconnect();
        } catch {
          // ignore
        }
        initialized = false;
        initPromise = null;
      }
    }, 60000); // 60秒无活动后断开
  };

  const ensureConnected = async (): Promise<void> => {
    if (disconnectTimeout) {
      clearTimeout(disconnectTimeout);
    }
    
    if (!initialized) {
      if (!initPromise) {
        initPromise = agent.initialize().then(() => {
          initialized = true;
        });
      }
      await initPromise;
    }
  };

  for (const action of baseActions) {
    const original = action.handler;
    action.handler = async (params, context): Promise<ActionResult> => {
      const loopContext = context as { state?: LoopState };
      const state = loopContext.state;

      // PLAN: 创建 bd 任务并更新状态
      if (action.name === 'PLAN' && state) {
        const tasks = Array.isArray(params.tasks)
          ? (params.tasks as Array<{ id?: string; description?: string; task?: string }>)
          : [];
        state.taskGraph = tasks.map((t, idx) => ({
          id: t.id || `task-${idx + 1}`,
          description: t.description || t.task || `task-${idx + 1}`,
          status: 'ready',
        }));

        for (const task of state.taskGraph) {
          const bdTask = await bdTools.createTask({
            title: task.description,
            type: 'task',
            parent: state.epicId,
            priority: 1,
          });
          task.bdTaskId = bdTask.id;
        }

        await bdTools.addComment(state.epicId, `拆解完成: ${state.taskGraph.length} 个任务`);
      }

      // DISPATCH: 派发一个 ready 任务
      if (action.name === 'DISPATCH' && state) {
        const taskId = String(params.taskId || '');
        const target = state.taskGraph.find(t => t.id === taskId && t.status === 'ready')
          || state.taskGraph.find(t => t.status === 'ready');
        if (!target) {
          return {
            success: false,
            observation: `DISPATCH failed: task not ready (${taskId})`,
            error: 'task not ready',
          };
        }

        
        // Emit task started event
        globalEventBus.emit({
          type: 'task_started',
          sessionId: config.sessionId || state.epicId,
          taskId: target.id,
          agentId: config.id,
          timestamp: new Date().toISOString(),
          payload: { title: target.description },
        });

target.status = 'in_progress';
        target.assignee = state.targetExecutorId;

        const result = await state.hub.sendToModule(state.targetExecutorId, {
          taskId: target.id,
          description: target.description,
          bdTaskId: target.bdTaskId,
        });

        target.result = {
          taskId: target.id,
          success: result.success !== false,
          output: result.output || result.result,
          error: result.error,
        };

        if (target.result.success) {
          target.status = 'completed';
          state.completedTasks.push(target.id);

          // Emit task completed event
          globalEventBus.emit({
            type: 'task_completed',
            sessionId: config.sessionId || state.epicId,
            taskId: target.id,
            agentId: state.targetExecutorId,
            timestamp: new Date().toISOString(),
            payload: { result: target.result.output },
          });

        } else {
          target.status = 'failed';
          state.failedTasks.push(target.id);
          state.lastError = target.result.error || 'unknown error';
          // Trigger checkpoint on task failure
          await registry.execute('CHECKPOINT', { trigger: 'task_failure' }, { state });

          // Emit task failed event
          globalEventBus.emit({
            type: 'task_failed',
            sessionId: config.sessionId || state.epicId,
            taskId: target.id,
            agentId: state.targetExecutorId,
            timestamp: new Date().toISOString(),
            payload: { error: target.result.error || 'unknown error' },
          });

        }

        // Emit workflow progress event
        const progress = state.taskGraph.length > 0
          ? (state.completedTasks.length / state.taskGraph.length) * 100
          : 0;
        globalEventBus.emit({
          type: 'workflow_progress',
          sessionId: config.sessionId || state.epicId,
          timestamp: new Date().toISOString(),
          payload: {
            overallProgress: progress,
            activeAgents: [config.id, state.targetExecutorId],
            pendingTasks: state.taskGraph.length - state.completedTasks.length - state.failedTasks.length,
            completedTasks: state.completedTasks.length,
            failedTasks: state.failedTasks.length,
          },
        });


        // Return real dispatch result so loop state and task statistics stay consistent.
        return {
          success: target.result.success,
          observation: target.result.success
            ? `任务 ${target.id} 已派发并执行成功`
            : `任务 ${target.id} 派发后执行失败: ${target.result.error || 'unknown error'}`,
          error: target.result.success ? undefined : target.result.error,
        };
      }

      // COMPLETE: 只有当所有任务完成时才允许
      if (action.name === 'COMPLETE' && state) {
        const allDone = state.taskGraph.length > 0 && state.taskGraph.every(
          t => t.status === 'completed' || t.status === 'failed'
        );
        if (!allDone) {
          return {
            success: false,
            observation: 'COMPLETE rejected: still has unfinished tasks',
            error: 'unfinished tasks',
          };
        }
        await bdTools.closeTask(state.epicId, state.failedTasks.length === 0 ? '所有任务完成' : '部分任务失败');
      }

      return original(params, context);
    };

    registry.register(action);

  // CHECKPOINT action for phase validation and rollback evaluation
  registry.register({
    name: 'CHECKPOINT',
    description: '阶段检查点：评估当前进度，判断是否需要回退或修复',
    paramsSchema: {
      trigger: { type: 'string', enum: ['reentry', 'task_failure', 'manual'], default: 'manual' },
    },
    handler: async (params, context): Promise<ActionResult> => {
      const loopContext = context as { state?: LoopState };
      const state = loopContext.state;
      if (!state) {
        return { success: false, observation: 'CHECKPOINT failed: no state' };
      }
      const trigger = (params.trigger as CheckpointTrigger) || 'manual';
      
      state.checkpoint.totalChecks++;
      state.checkpoint.lastTrigger = trigger;
      state.checkpoint.lastCheckAt = new Date().toISOString();
      
      console.log(`[OrchestratorLoop] CHECKPOINT #${state.checkpoint.totalChecks} (trigger=${trigger}, phase=${state.phase})`);
      
      // Evaluation logic - simplified for now
      const shouldRollback = state.lastError && 
                             state.checkpoint.totalChecks > 1 && 
                             state.failedTasks.length > 0;
      
      if (shouldRollback) {
        const previousPhase = state.phase;
        state.phase = 'planning';
        state.checkpoint.majorChange = true;
        
        const feedback = `检测到重大变更，从 ${previousPhase} 回退到 planning 阶段`;
        console.log(`[OrchestratorLoop] ${feedback}`);
        
        return {
          success: true,
          observation: feedback,
          shouldStop: true,
          stopReason: 'escalate',
        };
      }
      
      if (state.lastError) {
        runtimeInstructionBus.push(state.epicId, `检查点发现需要修复: ${state.lastError}`);
        return { success: true, observation: `Checkpoint: issues found, will attempt fix` };
      }
      
      return { success: true, observation: `Checkpoint: phase=${state.phase}, all good` };
    },
  });

  // Resume from epic support
  async function runLoopWithResume(
    userTask: string,
    resumeFromEpicId?: string
  ): Promise<unknown> {
    if (resumeFromEpicId) {
      console.log(`[OrchestratorLoop] Resuming from epic ${resumeFromEpicId}`);
      const tasks = await bdTools.getEpicTasks(resumeFromEpicId);
      console.log(`[OrchestratorLoop] Found ${tasks.length} existing tasks`);
    }
    return runLoop(userTask);
  }
  }

  async function runLoop(userTask: string): Promise<unknown> {
    await ensureConnected();

    const epic = await bdTools.createTask({
      title: userTask.substring(0, 100),
      type: 'epic',
      priority: 0,
      labels: ['orchestration', 'react-loop'],
    });

    const reviewer = config.enableReview
      ? new ReviewerRole({
          id: `${config.id}-reviewer`,
          name: `${config.name} Reviewer`,
          mode: config.mode,
          cwd: config.cwd,
        })
      : undefined;

    if (reviewer) {
      await reviewer.initialize();
    }

    const loopConfig: LoopConfig = {
      planner: { agent, actionRegistry: registry },
      reviewer: reviewer ? { agent: reviewer, enabled: true } : undefined,
      stopConditions: {
        completeActions: ['COMPLETE'],
        failActions: ['FAIL'],
        maxRounds: config.maxRounds ?? 10,
        onConvergence: true,
        onStuck: 3,
        maxRejections: 4,
      },
      formatFix: {
        maxRetries: 3,
        schema: {
          type: 'object',
          required: ['thought', 'action', 'params'],
          properties: {
            thought: { type: 'string' },
            action: { type: 'string' },
            params: { type: 'object' },
            expectedOutcome: { type: 'string' },
            risk: { type: 'string' },
          },
        },
      },
      snapshotLogger: logger,
      agentId: config.id,
    };

    const loop = new ReActLoop(loopConfig, userTask);

    const loopState: LoopState = {
      task: userTask,
      iterations: [],
      convergence: { rejectionStreak: 0, sameRejectionReason: '', stuckCount: 0 },
      epicId: epic.id,
      userTask,
      taskGraph: [],
      completedTasks: [],
      failedTasks: [],
      phase: 'planning',
      blockedTasks: [],
      checkpoint: { totalChecks: 0, majorChange: false },

      round: 0,
      hub,
      targetExecutorId: config.targetExecutorId || 'executor-loop',
    };

    (loop as unknown as { state: LoopState }).state = loopState;

    // Run initial checkpoint on reentry
    await registry.execute('CHECKPOINT', { trigger: 'reentry' }, { state: loopState });

    console.log(`[OrchestratorLoop] Initial checkpoint complete, phase=${loopState.phase}`);


    try {
      const result: ReActResult = await loop.run();
      const allDone = loopState.taskGraph.length > 0 && loopState.taskGraph.every(
        t => t.status === 'completed' || t.status === 'failed'
      );

      return {
        success: result.success && allDone && loopState.failedTasks.length === 0,
        epicId: epic.id,
        completed: loopState.completedTasks.length,
        failed: loopState.failedTasks.length,
        rounds: result.totalRounds,
        output: result.finalObservation,
      };
    } finally {
      if (reviewer) {
        await reviewer.disconnect();
      }
      // 调度延迟断开，避免频繁重连
      scheduleDisconnect();
    }
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'orchestrator-loop' },

    initialize: async () => {
      await ensureConnected();
    },

    destroy: async () => {
      if (disconnectTimeout) {
        clearTimeout(disconnectTimeout);
      }
      await agent.disconnect();
      initialized = false;
      initPromise = null;
    },

    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const msg = message as Record<string, unknown>;
      const userTask = String(msg.content ?? msg.task ?? msg.text ?? '');

      if (!userTask) {
        const error = { success: false, error: 'No task content' };
        if (callback) callback(error);
        return error;
      }

      try {
        const result = await runLoop(userTask);
        const wrapped = { success: true, result };
        if (callback) callback(wrapped);
        return wrapped;
      } catch (err) {
        const error = { success: false, error: err instanceof Error ? err.message : String(err) };
        if (callback) callback(error);
        return error;
      }
    },
  };

  return { agent, module };
}
