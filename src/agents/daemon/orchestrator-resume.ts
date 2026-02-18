/**
 * Orchestrator Resume Logic - 编排者状态恢复逻辑
 * 
 * 提供从 checkpoint 恢复状态的能力，包括：
 * 1. 阶段流转验证
 * 2. 恢复上下文构建
 * 3. 任务跳过/重试决策
 */

import type { SessionCheckpoint } from '../../orchestration/resumable-session.js';

export type OrchestratorPhase =
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

// Phase transition rules - defines valid phase transitions
export const PHASE_TRANSITIONS: Record<OrchestratorPhase, OrchestratorPhase[]> = {
  understanding: ['high_design', 'replanning'],
  high_design: ['detail_design', 'replanning'],
  detail_design: ['deliverables', 'replanning'],
  deliverables: ['plan', 'replanning'],
  plan: ['parallel_dispatch', 'replanning'],
  parallel_dispatch: ['blocked_review', 'verify', 'replanning'],
  blocked_review: ['verify', 'replanning'],
  verify: ['completed', 'replanning'],
  completed: [],
  failed: ['replanning'],
  replanning: ['understanding', 'high_design'],
};

export interface PhaseHistoryEntry {
  phase: OrchestratorPhase;
  timestamp: string;
  action: string;
}

export interface DesignArtifacts {
  architecture?: string;
  techStack?: string[];
  modules?: string[];
  rationale?: string;
  interfaces?: string[];
  dataModels?: string[];
  implementation?: string;
  acceptanceCriteria?: string[];
  testRequirements?: string[];
  artifacts?: string[];
}

export interface RecoveryContext {
  fromCheckpoint: boolean;
  resumePhase: OrchestratorPhase;
  skipCompletedTasks: string[];
  retryFailedTasks: string[];
  preservedDesign?: DesignArtifacts;
}

/**
 * Validate if a phase transition is allowed
 */
export function isValidPhaseTransition(from: OrchestratorPhase, to: OrchestratorPhase): boolean {
  if (from === to) return true;
  const allowedTransitions = PHASE_TRANSITIONS[from] || [];
  return allowedTransitions.includes(to);
}

/**
 * Determine which phase to resume from based on checkpoint state
 */
export function determineResumePhase(checkpoint: SessionCheckpoint): OrchestratorPhase {
  const context = checkpoint.context as { phase?: OrchestratorPhase } | undefined;
  const savedPhase = context?.phase || 'understanding';
  
  // If there are failed tasks, go back to plan phase to reassess
  if (checkpoint.failedTaskIds.length > 0) {
    return 'plan';
  }
  
  // If there are in-progress tasks, resume from parallel_dispatch
  const inProgress = checkpoint.taskProgress.filter(t => t.status === 'in_progress');
  if (inProgress.length > 0) {
    return 'parallel_dispatch';
  }
  
  // If all tasks completed, go to verify
  if (checkpoint.pendingTaskIds.length === 0 && checkpoint.completedTaskIds.length > 0) {
    return 'verify';
  }
  
  // Otherwise resume from saved phase
  return savedPhase;
}

/**
 * Build recovery context from checkpoint for model consumption
 */
export function buildRecoveryContext(
  checkpoint: SessionCheckpoint,
  existingDesign?: DesignArtifacts
): RecoveryContext {
  const resumePhase = determineResumePhase(checkpoint);
  const context = checkpoint.context as { 
    highDesign?: DesignArtifacts;
    detailDesign?: DesignArtifacts;
    deliverables?: DesignArtifacts;
  } | undefined;
  
  return {
    fromCheckpoint: true,
    resumePhase,
    skipCompletedTasks: checkpoint.completedTaskIds,
    retryFailedTasks: checkpoint.failedTaskIds,
    preservedDesign: existingDesign || {
      // Merge from checkpoint context if available
      ...(context?.highDesign || {}),
      ...(context?.detailDesign || {}),
      ...(context?.deliverables || {}),
    },
  };
}

/**
 * Generate resume prompt for the model
 */
export function generateResumePrompt(context: RecoveryContext, originalTask: string): string {
  const lines: string[] = [
    '# 任务恢复',
    '',
    `原始任务: ${originalTask}`,
    `恢复阶段: ${context.resumePhase}`,
    '',
  ];
  
  if (context.skipCompletedTasks.length > 0) {
    lines.push(`已完成的任务 (${context.skipCompletedTasks.length}个):`);
    lines.push(...context.skipCompletedTasks.map(id => `  - ${id}`));
    lines.push('');
  }
  
  if (context.retryFailedTasks.length > 0) {
    lines.push(`需要重试的失败任务 (${context.retryFailedTasks.length}个):`);
    lines.push(...context.retryFailedTasks.map(id => `  - ${id}`));
    lines.push('');
  }
  
  if (context.preservedDesign) {
    const d = context.preservedDesign;
    lines.push('已保存的设计信息:');
    if (d.architecture) lines.push(`  架构: ${d.architecture.substring(0, 100)}...`);
    if (d.modules?.length) lines.push(`  模块: ${d.modules.join(', ')}`);
    if (d.techStack?.length) lines.push(`  技术栈: ${d.techStack.join(', ')}`);
    if (d.artifacts?.length) lines.push(`  交付物: ${d.artifacts.join(', ')}`);
    lines.push('');
  }
  
  lines.push(`请从 ${context.resumePhase} 阶段继续执行任务。`);
  lines.push('如果处于 replanning 阶段，请先评估当前状态再决定下一步。');
  
  return lines.join('\n');
}

/**
 * Check if we should create a checkpoint at current phase
 */
export function shouldCheckpointAtPhase(phase: OrchestratorPhase): boolean {
  const checkpointPhases: OrchestratorPhase[] = [
    'understanding',
    'high_design',
    'detail_design',
    'deliverables',
    'plan',
    'blocked_review',
    'verify',
  ];
  return checkpointPhases.includes(phase);
}
