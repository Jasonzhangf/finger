/**
 * OrchestratorLoop LoopManager 适配器
 * 在原有 orchestrator-loop.ts 基础上，通过包装器集成 LoopManager
 */

import { loopManager } from '../../orchestration/loop/index.js';
import type { LoopNode } from '../../orchestration/loop/types.js';

export interface LoopIntegrationContext {
  epicId: string;
  userTask: string;
  planLoopId?: string;
  designLoopId?: string;
  executionLoopId?: string;
}

export function toLoopNodeStatus(status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed'): LoopNode['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'in_progress') return 'running';
  return 'waiting';
}

export function createPlanLoop(epicId: string, userTask: string): string {
  const planLoop = loopManager.createLoop(epicId, 'plan');
  loopManager.startLoop(planLoop.id);
  loopManager.addNode(planLoop.id, {
    type: 'orch',
    status: 'running',
    title: '需求分析与概要设计',
    text: userTask.substring(0, 100),
  });
  loopManager.transitionPhase(epicId, 'plan', 'Epic 创建');
  return planLoop.id;
}

export function completePlanLoop(epicId: string, planLoopId: string, architecture: string): string {
  loopManager.addNode(planLoopId, {
    type: 'review',
    status: 'done',
    title: '概要设计审核',
    text: `架构: ${architecture.substring(0, 30)}...`,
  });
  loopManager.completeLoop(planLoopId, 'success');
  loopManager.transitionPhase(epicId, 'design', '概要设计完成');
  
  const designLoop = loopManager.createLoop(epicId, 'design', planLoopId);
  loopManager.startLoop(designLoop.id);
  loopManager.addNode(designLoop.id, {
    type: 'orch',
    status: 'running',
    title: '详细设计',
    text: '正在制定详细设计',
  });
  return designLoop.id;
}

export function completeDesignLoop(epicId: string, designLoopId: string, interfaceCount: number): string {
  loopManager.addNode(designLoopId, {
    type: 'review',
    status: 'done',
    title: '详细设计审核',
    text: `接口: ${interfaceCount} 个`,
  });
  loopManager.completeLoop(designLoopId, 'success');
  loopManager.transitionPhase(epicId, 'execution', '详细设计完成');
  
  const executionLoop = loopManager.createLoop(epicId, 'execution', designLoopId);
  loopManager.startLoop(executionLoop.id);
  loopManager.addNode(executionLoop.id, {
    type: 'orch',
    status: 'running',
    title: '任务执行',
    text: '准备执行任务队列',
  });
  return executionLoop.id;
}

export function addDeliverablesNode(executionLoopId: string, artifactCount: number): void {
  loopManager.addNode(executionLoopId, {
    type: 'review',
    status: 'done',
    title: '交付物定义',
    text: `交付物: ${artifactCount} 项`,
  });
}

export function addExecNode(executionLoopId: string, taskId: string, description: string, agentId?: string): void {
  loopManager.addNode(executionLoopId, {
    type: 'exec',
    status: 'running',
    title: taskId,
    text: description.substring(0, 50),
    agentId,
  });
}

export function completeExecNode(executionLoopId: string, taskId: string, success: boolean): void {
  loopManager.addNode(executionLoopId, {
    type: 'exec',
    status: success ? 'done' : 'failed',
    title: taskId,
    text: success ? '执行完成' : '执行失败',
  });
}

export function completeExecutionLoop(epicId: string, executionLoopId: string, failedCount: number): void {
  loopManager.addNode(executionLoopId, {
    type: 'review',
    status: failedCount === 0 ? 'done' : 'failed',
    title: '最终审核',
    text: failedCount === 0 ? '全部通过' : `存在失败任务: ${failedCount}`,
  });
  loopManager.completeLoop(executionLoopId, failedCount === 0 ? 'success' : 'failed');
  loopManager.transitionPhase(epicId, failedCount === 0 ? 'completed' : 'failed', '执行阶段结束');
}

export function addResourceAllocatedNode(executionLoopId: string, taskId: string, resources: string[]): void {
  loopManager.addNode(executionLoopId, {
    type: 'exec',
    status: 'running',
    title: `资源分配: ${taskId}`,
    text: `已分配: ${resources.join(', ')}`,
  });
}

export function addResourceReleasedNode(executionLoopId: string, taskId: string): void {
  loopManager.addNode(executionLoopId, {
    type: 'exec',
    status: 'done',
    title: `资源释放: ${taskId}`,
    text: '资源已释放',
  });
}
