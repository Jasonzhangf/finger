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
import { resourcePool, type ResourceRequirement } from '../../orchestration/resource-pool.js';
import { buildAgentContext, generateDynamicSystemPrompt } from '../../orchestration/agent-context.js';

import type { OutputModule } from '../../orchestration/module-registry.js';
import {
  ActionRegistry,
  createOrchestratorActions,
  type ActionResult,
} from '../core/action-registry-simple.js';
import {
  ReActLoop,
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

必须输出 JSON：{"thought":"...","action":"HIGH_DESIGN|DETAIL_DESIGN|DELIVERABLES|PLAN|PARALLEL_DISPATCH|BLOCKED_REVIEW|VERIFY|COMPLETE|FAIL|STOP|START|QUERY_CAPABILITIES","params":{...}}

## 任务拆解原则

1. **粗粒度优先**：每个子任务应该是完整的、可独立执行的工作单元
2. **能力匹配**：根据资源池能力目录 (capability catalog) 分配任务
3. **动态工具**：Agent 能力基于其拥有的工具，工具可动态赋予
4. **减少调度开销**：每个子任务至少需要 5-10 分钟执行时间
5. **合理数量**：一般任务拆解为 3-7 个子任务

## 资源能力目录

资源池提供动态能力目录，通过 resourcePool.getCapabilityCatalog() 获取。


### 能力与工具映射

Agent 的能力由其拥有的工具决定：
- **web_search**: 拥有 web_search 工具的 Agent
- **file_ops**: 拥有 read_file, write_file 工具的 Agent
- **code_generation**: 拥有代码生成工具的 Agent
- **shell_exec**: 拥有 shell 执行工具的 Agent
- **report_generation**: 拥有报告生成工具的 Agent

### 动态工具赋予

后续将支持定时工具赋予机制：
1. 创建定时任务资源
2. 将定时工具派发给 Agent
3. Agent 获得新的 schedule_task 能力
4. 资源池自动更新能力目录

### 任务派发流程

1. 查询能力目录：resourcePool.getCapabilityCatalog()
2. 根据任务需求匹配能力
3. 分配具备该能力的 Agent
4. 执行任务
5. 释放资源

示例（基于能力的任务分配）：
- "搜索 DeepSeek 论文" → 需要 web_search 能力 → 分配 executor-research
- "创建项目文件" → 需要 file_ops 能力 → 分配 executor-general 或 executor-coding
- "生成分析报告" → 需要 report_generation 能力 → 分配 executor-research
`;

  // Build initial agent context with resource pool info
  const initialContext = buildAgentContext();
  const dynamicSystemPrompt = generateDynamicSystemPrompt(systemPrompt, initialContext);
  
  const agent = new Agent({
    id: config.id,
    name: config.name,
    mode: config.mode,
    provider: 'iflow',
    systemPrompt: dynamicSystemPrompt,
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
      context,
      state.phaseHistory ?? []
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

    // Emit phase transition event for real-time monitoring
    const currentPhaseIndex = state.phaseHistory.findIndex(entry => entry.checkpointId === checkpoint.checkpointId);
    const previousPhaseEntry = currentPhaseIndex > 0 ? state.phaseHistory[currentPhaseIndex - 1] : undefined;
    const previousPhase = previousPhaseEntry ? previousPhaseEntry.phase : 'understanding';
    
    globalEventBus.emit({
      type: 'phase_transition',
      sessionId: config.sessionId || state.epicId,
      timestamp: new Date().toISOString(),
      agentId: config.id,
      payload: {
        from: previousPhase,
        to: state.phase,
        triggerAction: reason,
        checkpointId: checkpoint.checkpointId,
        round: state.round,
      },
    });
    // Cleanup old checkpoints after each save, keep last 10
    resumableSessionManager.cleanupOldCheckpoints(sessionId, 10);

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

      // Handle PARALLEL_DISPATCH action with resource pool
      if (action.name === 'PARALLEL_DISPATCH' && state) {
        const taskIds = Array.isArray(params.taskIds) ? params.taskIds as string[] : [];
        if (taskIds.length === 0) {
          return { success: false, observation: 'PARALLEL_DISPATCH failed: no taskIds' };
        }
        
        // First, query capability catalog to understand available resources
        const capabilityCatalog = resourcePool.getCapabilityCatalog();
        console.log(`[Orchestrator] Capability catalog: ${capabilityCatalog.map(c => `${c.capability}(${c.availableCount}/${c.resourceCount})`).join(', ')}`);
        
        // Get ready tasks
        const tasksToDispatch = taskIds
          .map(id => state.taskGraph.find(t => t.id === id))
          .filter((t): t is NonNullable<typeof t> => t !== undefined && t.status === 'ready');
        
        // Allocate resources for each task based on task description and capability catalog
        const allocationResults: Array<{ taskId: string; success: boolean; resources?: string[]; error?: string }> = [];
        const tasksWithResources: Array<typeof tasksToDispatch[number] & { allocatedResources: string[] }> = [];
        
        for (const task of tasksToDispatch) {
          // Infer resource requirements from task description
          const requirements: ResourceRequirement[] = inferResourceRequirements(task.description);
          
          // Check if required capabilities are available
          const missingCapabilities: string[] = [];
          for (const req of requirements) {
            const capEntry = capabilityCatalog.find(c => c.capability === (req.capabilities?.[0] || req.type));
            if (!capEntry || capEntry.availableCount === 0) {
              missingCapabilities.push(req.capabilities?.[0] || req.type);
            }
          }
          
          if (missingCapabilities.length > 0) {
            allocationResults.push({ 
              taskId: task.id, 
              success: false, 
              error: `缺乏能力：${missingCapabilities.join(', ')}`,
            });
          } else {
            const allocation = resourcePool.allocateResources(task.id, requirements);
            
            if (allocation.success && allocation.allocatedResources) {
              allocationResults.push({ taskId: task.id, success: true, resources: allocation.allocatedResources });
              tasksWithResources.push({ ...task, allocatedResources: allocation.allocatedResources });
            } else {
              allocationResults.push({ 
                taskId: task.id, 
                success: false, 
                error: allocation.error || 'Allocation failed',
              });
            }
          }
        }
        
        // Check if any tasks failed allocation
        const failedAllocations = allocationResults.filter(r => !r.success);
        if (failedAllocations.length > 0) {
          // Report resource shortage and enter BLOCKED state
          const missingInfo = failedAllocations.map(r => `Task ${r.taskId}: ${r.error}`).join('; ');
          state.phase = 'blocked_review';
          await saveCheckpoint(state, 'resource_shortage');
          await bdTools.addComment(state.epicId, `资源缺乏：${missingInfo}`);
          
          return {
            success: false,
            observation: `资源缺乏，无法派发任务：${missingInfo}`,
            error: 'resource_shortage',
            data: { 
              failedAllocations,
              suggestion: '请添加所需资源或调整任务拆解',
            },
          };
        }
        
        // Dispatch tasks with allocated resources and context
        const dispatchPromises = tasksWithResources.map(async (task) => {
          const targetExecutorId = task.allocatedResources[0] || state.targetExecutorId;
          
          try {
            resourcePool.markTaskExecuting(task.id);
            
            // Build task-specific context for the executor
            const taskContext = buildAgentContext({
              taskId: task.id,
              taskDescription: task.description,
              requiredCapabilities: inferResourceRequirements(task.description).map(r => r.capabilities?.[0] || r.type).filter(Boolean),
              bdTaskId: task.bdTaskId,
              orchestratorNote: `请使用 ${targetExecutorId} 执行此任务，已分配资源：${task.allocatedResources.join(', ')}`,
            });
            
            const result = await state.hub.sendToModule(targetExecutorId, {
              taskId: task.id,
              description: task.description,
              bdTaskId: task.bdTaskId,
              context: taskContext, // Include context for task-aware execution
            });
            task.result = { taskId: task.id, success: result.success !== false, output: result.output, error: result.error };
            
            if (result.success !== false) {
              task.status = 'completed';
              state.completedTasks.push(task.id);
              resourcePool.releaseResources(task.id, 'completed');
              return { taskId: task.id, success: true, result };
            } else {
              task.status = 'failed';
              state.failedTasks.push(task.id);
              resourcePool.releaseResources(task.id, 'error');
              return { taskId: task.id, success: false, error: result.error };
            }
          } catch (err) {
            task.status = 'failed';
            task.result = { taskId: task.id, success: false, error: String(err) };
            state.failedTasks.push(task.id);
            resourcePool.releaseResources(task.id, 'error');
            return { taskId: task.id, success: false, error: String(err) };
          }
        });
        
        const results = await Promise.allSettled(dispatchPromises);
        const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
        const failCount = results.filter(r => r.status === 'fulfilled' && !r.value.success).length;
        
        state.phase = 'parallel_dispatch';
        await saveCheckpoint(state, 'parallel_dispatch_completed');
        
        return { 
          success: successCount > 0, 
          observation: `并行派发完成：成功${successCount}/${tasksToDispatch.length}, 失败${failCount}`,
          data: { dispatched: tasksToDispatch.length, success: successCount, failed: failCount },
        };
      }

      // Helper function to infer resource requirements from task description
      function inferResourceRequirements(description: string): ResourceRequirement[] {
        const desc = description.toLowerCase();
        const requirements: ResourceRequirement[] = [];
        
        if (desc.includes('搜索') || desc.includes('search') || desc.includes('调研') || desc.includes('分析')) {
          requirements.push({ type: 'executor', minLevel: 7, capabilities: ['web_search'] });
        }
        if (desc.includes('代码') || desc.includes('code') || desc.includes('编程') || desc.includes('开发')) {
          requirements.push({ type: 'executor', minLevel: 7, capabilities: ['code_generation'] });
        }
        if (desc.includes('文件') || desc.includes('file') || desc.includes('保存') || desc.includes('创建')) {
          requirements.push({ type: 'executor', minLevel: 5, capabilities: ['file_ops'] });
        }
        if (desc.includes('报告') || desc.includes('report') || desc.includes('总结')) {
          requirements.push({ type: 'executor', minLevel: 7, capabilities: ['report_generation'] });
        }
        
        // Default to general executor if no specific requirements
        if (requirements.length === 0) {
          requirements.push({ type: 'executor', minLevel: 5 });
        }
        
        return requirements;
      }

      // Handle BLOCKED_REVIEW action
      if (action.name === 'BLOCKED_REVIEW' && state) {
        const blockedTaskIds = Array.isArray(params.blockedTaskIds) 
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
      
      // Handle STOP action - pause task dispatching
      if (action.name === 'STOP' && state) {
        const reason = String(params.reason || 'manual');
        const isResourceShortage = reason.includes('资源缺乏') || reason.includes('resource');
        
        if (isResourceShortage) {
          state.phase = 'blocked_review';
          await saveCheckpoint(state, `blocked: ${reason}`);
          await bdTools.updateStatus(state.epicId, 'blocked');
          await bdTools.addComment(state.epicId, `资源缺乏：${reason}`);
          
          return {
            success: true,
            observation: `资源缺乏，任务阻塞：${reason}`,
            error: 'resource_shortage',
            data: { 
              blocked: true, 
              reason, 
              pendingTasks: state.taskGraph.filter(t => t.status === 'ready').length,
              resourceStatus: resourcePool.getStatusReport(),
              recoveryAction: '添加所需资源后使用 START 命令恢复',
            },
          };
        } else {
          state.phase = 'paused';
          await saveCheckpoint(state, `stopped: ${reason}`);
          await bdTools.addComment(state.epicId, `编排已暂停：${reason}`);
          
          return { 
            success: true, 
            observation: `编排已暂停：${reason}`,
            data: { paused: true, reason, pendingTasks: state.taskGraph.filter(t => t.status === 'ready').length },
          };
        }
      }
      
      // Handle START action - resume task dispatching
      if (action.name === 'START' && state) {
        if (state.phase !== 'paused' && state.phase !== 'blocked_review') {
          return { success: false, observation: 'START rejected: not paused or blocked', error: 'invalid state' };
        }
        
        // Check if resources are now available for blocked tasks
        if (state.phase === 'blocked_review') {
          const readyTasks = state.taskGraph.filter(t => t.status === 'ready');
          const resourceCheckResults: Array<{ taskId: string; satisfied: boolean; missing?: string[] }> = [];
          
          for (const task of readyTasks) {
            const requirements = inferResourceRequirements(task.description);
            const check = resourcePool.checkResourceRequirements(requirements);
            
            if (!check.satisfied) {
              resourceCheckResults.push({
                taskId: task.id,
                satisfied: false,
                missing: check.missingResources.map(r => r.type),
              });
            }
          }
          
          if (resourceCheckResults.length > 0) {
            return {
              success: false,
              observation: `资源仍然不足，无法恢复：${resourceCheckResults.map(r => `Task ${r.taskId} 缺少 ${r.missing?.join(',')}`).join('; ')}`,
              error: 'resource_still_shortage',
              data: { resourceCheckResults, suggestion: '请先添加所需资源' },
            };
          }
        }
        
        state.phase = 'parallel_dispatch';
        await saveCheckpoint(state, 'resumed');
        await bdTools.updateStatus(state.epicId, 'in_progress');
        await bdTools.addComment(state.epicId, '编排已恢复，资源已就绪');
        
        return { 
          success: true, 
          observation: '编排已恢复，继续派发任务',
          data: { 
            paused: false, 
            pendingTasks: state.taskGraph.filter(t => t.status === 'ready').length,
            resourceStatus: resourcePool.getStatusReport(),
          },
        };
      }
      
      // Handle QUERY_CAPABILITIES action - get current capability catalog
      if (action.name === 'QUERY_CAPABILITIES' && state) {
        const capabilityCatalog = resourcePool.getCapabilityCatalog();
        const resourceStatus = resourcePool.getStatusReport();
        
        return {
          success: true,
          observation: `能力目录查询完成：${capabilityCatalog.length} 种能力，${resourceStatus.totalResources} 个资源`,
          data: {
            capabilityCatalog,
            resourceStatus,
            availableCapabilities: capabilityCatalog
              .filter(c => c.availableCount > 0)
              .map(c => ({ capability: c.capability, availableCount: c.availableCount })),
          },
        };
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
    
    // Refresh agent context with latest resource pool state before starting
    const refreshedContext = buildAgentContext();
    const refreshedPrompt = generateDynamicSystemPrompt(systemPrompt, refreshedContext);
    agent.systemPrompt = refreshedPrompt;
    
    await registry.execute('CHECKPOINT', { trigger: 'reentry' }, { state: loopState });
    try {
      const result: ReActResult = await loop.run();
      const allDone = loopState.taskGraph.length > 0 && loopState.taskGraph.every(t => t.status === 'completed' || t.status === 'failed');
      return { success: result.success && allDone && loopState.failedTasks.length === 0, epicId: epic.id, completed: loopState.completedTasks.length, failed: loopState.failedTasks.length, rounds: result.totalRounds, output: result.finalObservation };
    } finally {
      if (reviewer) await reviewer.disconnect();
      // Clean up old checkpoints, keep last 10
      resumableSessionManager.cleanupOldCheckpoints(resumeSessionId, 10);
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
