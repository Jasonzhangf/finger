/**
 * 编排者 ReACT 循环 - 基于通用 ReACT Loop
 */

import { Agent } from '../agent.js';
import { ReviewerRole } from '../roles/reviewer.js';
import { BdTools } from '../shared/bd-tools.js';
import { createSnapshotLogger, SnapshotLogger } from '../shared/snapshot-logger.js';
import { MessageHub } from '../../orchestration/message-hub.js';
import { globalEventBus } from '../../runtime/event-bus.js';
import { runtimeInstructionBus } from '../../orchestration/runtime-instruction-bus.js';
import { resumableSessionManager, determineResumePhase, type TaskProgress } from '../../orchestration/resumable-session.js';

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
  blockedBy?: string[];
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
  | 'understanding'
  | 'high_design'
  | 'detail_design'
  | 'deliverables'
  | 'plan'
  | 'parallel_dispatch'
  | 'blocked_review'
  | 'verify'
  | 'completed'
  | 'failed'
  | 'replanning';

type CheckpointTrigger = 'reentry' | 'task_failure';

interface CheckpointState {
  totalChecks: number;
  lastTrigger?: CheckpointTrigger;
  lastCheckAt?: string;
  majorChange: boolean;
  lastCheckpointId?: string;
  lastCheckpointAt?: string;
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
  highDesign?: { architecture: string; techStack: string[]; modules: string[]; rationale?: string };
  detailDesign?: { interfaces: string[]; dataModels: string[]; implementation: string };
  deliverables?: { acceptanceCriteria: string[]; testRequirements: string[]; artifacts: string[] };
  phaseHistory?: Array<{ phase: OrchestratorPhase; timestamp: string; action: string; checkpointId?: string }>;
}

export function createOrchestratorLoop(
  config: OrchestratorLoopConfig,
  hub: MessageHub
): { agent: Agent; module: OutputModule } {
  const systemPrompt = config.systemPrompt ?? `
你是一个任务编排专家。职责是把用户任务拆成子任务并调度执行。

必须输出 JSON：{"thought":"...","action":"HIGH_DESIGN|DETAIL_DESIGN|DELIVERABLES|PLAN|PARALLEL_DISPATCH|BLOCKED_REVIEW|VERIFY|COMPLETE|FAIL","params":{...}}
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

  // Helper: Create checkpoint for current state
  async function saveCheckpoint(state: LoopState, reason: string = 'phase_transition'): Promise<void> {
    const sessionId = config.sessionId || config.id;
    const taskProgress: TaskProgress[] = state.taskGraph.map(task => ({
      taskId: task.id,
      description: task.description,
      status: task.status as TaskProgress['status'],
      assignedAgent: task.assignee,
      startedAt: task.result ? new Date().toISOString() : undefined,
      completedAt: task.status === 'completed' || task.status === 'failed' ? new Date().toISOString() : undefined,
      result: task.result ? { success: task.result.success, output: task.result.output, error: task.result.error } : undefined,
      iterationCount: 1,
      maxIterations: 10,
    }));

    const agentStates: Record<string, { agentId: string; currentTaskId?: string; status: string; round: number; thought?: string }> = {
      [config.id]: {
        agentId: config.id,
        status: state.phase,
        round: state.round,
      },
    };

    const context = {
      phase: state.phase,
      highDesign: state.highDesign,
      detailDesign: state.detailDesign,
      deliverables: state.deliverables,
      reason,
    };

    const checkpoint = resumableSessionManager.createCheckpoint(
      sessionId,
      state.userTask,
      taskProgress,
      agentStates,
      context
    );

    state.checkpoint.lastCheckpointId = checkpoint.checkpointId;
    state.checkpoint.lastCheckpointAt = new Date().toISOString();

    // Add to phase history
    if (!state.phaseHistory) {
      state.phaseHistory = [];
    }
    state.phaseHistory.push({
      phase: state.phase,
      timestamp: checkpoint.timestamp,
      action: reason,
      checkpointId: checkpoint.checkpointId,
    });

    console.log(`[Orchestrator] Checkpoint saved: ${checkpoint.checkpointId} (phase=${state.phase}, reason=${reason})`);
  }

  const registry = new ActionRegistry();
  const baseActions = createOrchestratorActions();


  const ensureConnected = async (): Promise<void> => {
    if (!initialized) {
      if (!initPromise) {
        initPromise = agent.initialize().then(() => { initialized = true; });
      }
      await initPromise;
    }
  };

  for (const action of baseActions) {
    const original = action.handler;
    action.handler = async (params, context): Promise<ActionResult> => {
      const loopContext = context as { state?: LoopState };
      const state = loopContext.state;

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
        state.phase = 'plan';
        await saveCheckpoint(state, 'plan_completed');
      }

      if (action.name === 'DISPATCH' && state) {
        const taskId = String(params.taskId || '');
        const target = state.taskGraph.find(t => t.id === taskId && t.status === 'ready')
          || state.taskGraph.find(t => t.status === 'ready');
        if (!target) {
          return { success: false, observation: `DISPATCH failed: task not ready (${taskId})`, error: 'task not ready' };
        }
        target.status = 'in_progress';
        target.assignee = state.targetExecutorId;
        globalEventBus.emit({
          type: 'task_started',
          sessionId: config.sessionId || state.epicId,
          taskId: target.id,
          agentId: config.id,
          timestamp: new Date().toISOString(),
          payload: { title: target.description },
        });
        const result = await state.hub.sendToModule(state.targetExecutorId, {
          taskId: target.id,
          description: target.description,
          bdTaskId: target.bdTaskId,
        });
        target.result = { taskId: target.id, success: result.success !== false, output: result.output || result.result, error: result.error };
        if (target.result.success) {
          target.status = 'completed';
          state.completedTasks.push(target.id);
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
          await registry.execute('CHECKPOINT', { trigger: 'task_failure' }, { state });
          globalEventBus.emit({
            type: 'task_failed',
            sessionId: config.sessionId || state.epicId,
            taskId: target.id,
            agentId: state.targetExecutorId,
            timestamp: new Date().toISOString(),
            payload: { error: target.result.error || 'unknown error' },
          });
        }
        const progress = state.taskGraph.length > 0 ? (state.completedTasks.length / state.taskGraph.length) * 100 : 0;
        globalEventBus.emit({
          type: 'workflow_progress',
          sessionId: config.sessionId || state.epicId,
          timestamp: new Date().toISOString(),
          payload: { overallProgress: progress, activeAgents: [config.id, state.targetExecutorId], pendingTasks: state.taskGraph.length - state.completedTasks.length - state.failedTasks.length, completedTasks: state.completedTasks.length, failedTasks: state.failedTasks.length },
        });
        return { success: target.result.success, observation: target.result.success ? `任务 ${target.id} 已派发并执行成功` : `任务 ${target.id} 派发后执行失败: ${target.result.error || 'unknown error'}`, error: target.result.success ? undefined : target.result.error };
      }


      // Handle HIGH_DESIGN action
      if (action.name === 'HIGH_DESIGN' && state) {
        state.highDesign = {
          architecture: String(params.architecture || ''),
          techStack: Array.isArray(params.techStack) ? params.techStack as string[] : [],
          modules: Array.isArray(params.modules) ? params.modules as string[] : [],
          rationale: params.rationale ? String(params.rationale) : undefined,
        };
        state.phase = 'high_design';
        await bdTools.addComment(state.epicId, `概要设计完成：架构=${state.highDesign.architecture.substring(0, 50)}..., 模块数=${state.highDesign.modules.length}`);
        await saveCheckpoint(state, 'high_design_completed');
        return { success: true, observation: `概要设计已保存`, data: state.highDesign };
      }

      // Handle DETAIL_DESIGN action
      if (action.name === 'DETAIL_DESIGN' && state) {
        state.detailDesign = {
          interfaces: Array.isArray(params.interfaces) ? params.interfaces as string[] : [],
          dataModels: Array.isArray(params.dataModels) ? params.dataModels as string[] : [],
          implementation: String(params.implementation || ''),
        };
        state.phase = 'detail_design';
        await bdTools.addComment(state.epicId, `详细设计完成：接口数=${state.detailDesign.interfaces.length}, 数据模型数=${state.detailDesign.dataModels.length}`);
        await saveCheckpoint(state, 'detail_design_completed');
        return { success: true, observation: `详细设计已保存`, data: state.detailDesign };
      }

      // Handle DELIVERABLES action
      if (action.name === 'DELIVERABLES' && state) {
        state.deliverables = {
          acceptanceCriteria: Array.isArray(params.acceptanceCriteria) ? params.acceptanceCriteria as string[] : [],
          testRequirements: Array.isArray(params.testRequirements) ? params.testRequirements as string[] : [],
          artifacts: Array.isArray(params.artifacts) ? params.artifacts as string[] : [],
        };
        state.phase = 'deliverables';
        await bdTools.addComment(state.epicId, `交付清单完成：交付物数=${state.deliverables.artifacts.length}`);
        await saveCheckpoint(state, 'deliverables_completed');
        return { success: true, observation: `交付清单已保存`, data: state.deliverables };
      }

      // Handle PARALLEL_DISPATCH action
      if (action.name === 'PARALLEL_DISPATCH' && state) {
        const taskIds = Array.isArray(params.taskIds) ? params.taskIds as string[] : [];
        if (taskIds.length === 0) {
          return { success: false, observation: 'PARALLEL_DISPATCH failed: no taskIds' };
        }
        const targetExecutorId = String(params.targetExecutorId || state.targetExecutorId);
        let successCount = 0;
        let failCount = 0;
        
        for (const taskId of taskIds) {
          const task = state.taskGraph.find(t => t.id === taskId);
          if (!task || task.status !== 'ready') continue;
          
          task.status = 'in_progress';
          task.assignee = targetExecutorId;
          
          try {
            const result = await state.hub.sendToModule(targetExecutorId, {
              taskId,
              description: task.description,
              bdTaskId: task.bdTaskId,
            });
            task.result = { taskId, success: result.success !== false, output: result.output, error: result.error };
            
            if (result.success !== false) {
              task.status = 'completed';
              state.completedTasks.push(taskId);
              successCount++;
            } else {
              task.status = 'failed';
              state.failedTasks.push(taskId);
              failCount++;
            }
          } catch (err) {
            task.status = 'failed';
            state.failedTasks.push(taskId);
            failCount++;
          }
        }
        
        state.phase = 'parallel_dispatch';
        await saveCheckpoint(state, 'parallel_dispatch_completed');
        return { success: successCount > 0, observation: `并行派发完成：成功${successCount}/${taskIds.length}, 失败${failCount}` };
      }

      // Handle BLOCKED_REVIEW action
      if (action.name === 'BLOCKED_REVIEW' && state) {
        let blockedTaskIds = Array.isArray(params.blockedTaskIds) 
          ? params.blockedTaskIds as string[] 
          : state.blockedTasks || [];
        
        if (blockedTaskIds.length === 0) {
          return { success: true, observation: '无阻塞任务需要处理' };
        }
        
        const targetExecutorId = String(params.strongestResourceId || state.targetExecutorId);
        let handledCount = 0;
        
        for (const taskId of blockedTaskIds) {
          const task = state.taskGraph.find(t => t.id === taskId);
          if (!task) continue;
          
          // Check dependencies
          const depsResolved = !task.blockedBy || task.blockedBy.every((depId: string) => {
            const depTask = state.taskGraph.find(t => t.id === depId);
            return depTask && depTask.status === 'completed';
          });
          
          if (!depsResolved) continue;
          
          task.status = 'in_progress';
          task.assignee = targetExecutorId;
          
          try {
            const result = await state.hub.sendToModule(targetExecutorId, {
              taskId,
              description: task.description,
              bdTaskId: task.bdTaskId,
            });
            
            if (result.success !== false) {
              task.status = 'completed';
              state.completedTasks.push(taskId);
              state.blockedTasks = state.blockedTasks.filter(id => id !== taskId);
              handledCount++;
            }
          } catch {
            // Keep in blockedTasks
          }
        }
        
        state.phase = 'blocked_review';
        await saveCheckpoint(state, 'blocked_review_completed');
        return { success: true, observation: `阻塞任务审查完成：处理${handledCount}/${blockedTaskIds.length}个` };
      }

      // Handle VERIFY action
      if (action.name === 'VERIFY' && state) {
        if (!state.deliverables) {
          return { success: false, observation: 'VERIFY failed: no deliverables defined' };
        }
        
        const totalTasks = state.taskGraph.length;
        const completedTasks = state.completedTasks.length;
        const completionRate = totalTasks > 0 ? completedTasks / totalTasks : 0;
        
        // Check if all deliverables are complete
        const allDeliverablesComplete = state.deliverables.artifacts.every(artifact => 
          state.taskGraph.some(t => t.description.includes(artifact) && t.status === 'completed')
        );
        
        const highCompletionRate = completionRate >= 0.8;
        const passed = allDeliverablesComplete && highCompletionRate;
        
        state.phase = 'verify';
        await saveCheckpoint(state, 'verify_completed');

        if (passed) {
          await bdTools.closeTask(state.epicId, '所有交付物验证通过');
          return { 
            success: true, 
            observation: `交付物验证通过：完成率${Math.round(completionRate * 100)}%`,
            shouldStop: true,
            stopReason: 'complete',
          };
        } else {
          return { 
            success: false, 
            observation: `交付物验证失败：完成率${Math.round(completionRate * 100)}%，需要重规划`,
          };
        }
      }
      if (action.name === 'COMPLETE' && state) {
        const allDone = state.taskGraph.length > 0 && state.taskGraph.every(t => t.status === 'completed' || t.status === 'failed');
        if (!allDone) return { success: false, observation: 'COMPLETE rejected: still has unfinished tasks', error: 'unfinished tasks' };
        await bdTools.closeTask(state.epicId, state.failedTasks.length === 0 ? '所有任务完成' : '部分任务失败');
      }
      return original(params, context);
    };
    registry.register(action);
  }

  registry.register({
    name: 'CHECKPOINT',
    description: '阶段检查点：评估当前进度，判断是否需要回退或修复',
    paramsSchema: { trigger: { type: 'string', enum: ['reentry', 'task_failure', 'manual'], default: 'manual' } },
    handler: async (params, context): Promise<ActionResult> => {
      const loopContext = context as { state?: LoopState };
      const state = loopContext.state;
      if (!state) return { success: false, observation: 'CHECKPOINT failed: no state' };
      const trigger = (params.trigger as CheckpointTrigger) || 'manual';
      state.checkpoint.totalChecks++;
      state.checkpoint.lastTrigger = trigger;
      state.checkpoint.lastCheckAt = new Date().toISOString();
      const shouldRollback = state.lastError && state.checkpoint.totalChecks > 1 && state.failedTasks.length > 0;
      if (shouldRollback) {
        const previousPhase = state.phase;
        state.phase = 'replanning';
        state.checkpoint.majorChange = true;
        const feedback = `检测到重大变更，从 ${previousPhase} 回退到 planning 阶段`;
        return { success: true, observation: feedback, shouldStop: true, stopReason: 'escalate' };
      }
      if (state.lastError) {
        runtimeInstructionBus.push(state.epicId, `检查点发现需要修复: ${state.lastError}`);
        return { success: true, observation: `Checkpoint: issues found, will attempt fix` };
      }
      return { success: true, observation: `Checkpoint: phase=${state.phase}, all good` };
    },
  });

 async function runLoop(userTask: string): Promise<unknown> {
   await ensureConnected();
   const epic = await bdTools.createTask({ title: userTask.substring(0, 100), type: 'epic', priority: 0, labels: ['orchestration', 'react-loop'] });
   const resumeSessionId = config.sessionId || config.id;
   const latestCheckpoint = resumableSessionManager.findLatestCheckpoint(resumeSessionId);
   const resumedPhase = latestCheckpoint
     ? (determineResumePhase(latestCheckpoint) as OrchestratorPhase)
     : 'replanning';
    
    // Restore state from checkpoint if available
    let initialTaskGraph: TaskNode[] = [];
    let initialCompletedTasks: string[] = [];
    let initialFailedTasks: string[] = [];
    let initialBlockedTasks: string[] = [];
    let initialHighDesign: LoopState['highDesign'] = undefined;
    let initialDetailDesign: LoopState['detailDesign'] = undefined;
    let initialDeliverables: LoopState['deliverables'] = undefined;
    
    if (latestCheckpoint) {
      console.log(`[Orchestrator] Restoring from checkpoint ${latestCheckpoint.checkpointId}...`);
      
      // Restore task graph
      initialTaskGraph = latestCheckpoint.taskProgress.map(tp => ({
        id: tp.taskId,
        description: tp.description,
        status: tp.status as TaskNode['status'],
        assignee: tp.assignedAgent,
        result: tp.result ? { taskId: tp.taskId, success: tp.result.success, output: tp.result.output, error: tp.result.error } : undefined,
        bdTaskId: undefined, // Will be re-linked if needed
      }));
      
      // Restore completed/failed task lists
      initialCompletedTasks = [...latestCheckpoint.completedTaskIds];
      initialFailedTasks = [...latestCheckpoint.failedTaskIds];
      
      // Restore blocked tasks (pending but not completed)
      initialBlockedTasks = latestCheckpoint.pendingTaskIds.filter(id => 
        !initialCompletedTasks.includes(id) && !initialFailedTasks.includes(id)
      );
      
      // Restore design artifacts from context
      const ctx = latestCheckpoint.context as {
        highDesign?: LoopState['highDesign'];
        detailDesign?: LoopState['detailDesign'];
        deliverables?: LoopState['deliverables'];
      };
      initialHighDesign = ctx.highDesign;
      initialDetailDesign = ctx.detailDesign;
      initialDeliverables = ctx.deliverables;
      
      console.log(`[Orchestrator] Restored: phase=${resumedPhase}, tasks=${initialTaskGraph.length}, completed=${initialCompletedTasks.length}, failed=${initialFailedTasks.length}`);
    }
    
   const reviewer = config.enableReview ? new ReviewerRole({ id: `${config.id}-reviewer`, name: `${config.name} Reviewer`, mode: config.mode, cwd: config.cwd }) : undefined;
   if (reviewer) await reviewer.initialize();
    const loopConfig: LoopConfig = {
      planner: { agent, actionRegistry: registry },
      reviewer: reviewer ? { agent: reviewer, enabled: true } : undefined,
      stopConditions: { completeActions: ['COMPLETE'], failActions: ['FAIL'], maxRounds: config.maxRounds ?? 10, onConvergence: true, onStuck: 3, maxRejections: 4 },
      formatFix: { maxRetries: 10, schema: { type: 'object', required: ['thought', 'action', 'params'], properties: { thought: { type: 'string' }, action: { type: 'string' }, params: { type: 'object' }, expectedOutcome: { type: 'string' }, risk: { type: 'string' } } } },
      snapshotLogger: logger,
      agentId: config.id,
    };
    const loop = new ReActLoop(loopConfig, userTask);
    const loopState: LoopState = {
      task: userTask, iterations: [], convergence: { rejectionStreak: 0, sameRejectionReason: '', stuckCount: 0 },
      epicId: epic.id, userTask, taskGraph: initialTaskGraph, completedTasks: initialCompletedTasks, failedTasks: initialFailedTasks, phase: resumedPhase, blockedTasks: initialBlockedTasks,
      highDesign: initialHighDesign, detailDesign: initialDetailDesign, deliverables: initialDeliverables,
      checkpoint: { totalChecks: 0, majorChange: false }, round: 0, hub, targetExecutorId: config.targetExecutorId || 'executor-loop',
    };
    (loop as unknown as { state: LoopState }).state = loopState;
    await registry.execute('CHECKPOINT', { trigger: 'reentry' }, { state: loopState });
    try {
      const result: ReActResult = await loop.run();
      const allDone = loopState.taskGraph.length > 0 && loopState.taskGraph.every(t => t.status === 'completed' || t.status === 'failed');
      return { success: result.success && allDone && loopState.failedTasks.length === 0, epicId: epic.id, completed: loopState.completedTasks.length, failed: loopState.failedTasks.length, rounds: result.totalRounds, output: result.finalObservation };
    } finally {
      if (reviewer) await reviewer.disconnect();
    }
  }

  const module: OutputModule = {
    id: config.id,
    type: 'output',
    name: config.name,
    version: '1.0.0',
    metadata: { mode: config.mode, provider: 'iflow', type: 'orchestrator-loop' },
    initialize: async () => { await ensureConnected(); },
    destroy: async () => {
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
