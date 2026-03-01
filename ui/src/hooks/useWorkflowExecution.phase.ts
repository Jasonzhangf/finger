import type { WorkflowFSMState, WorkflowStatus } from '../api/types.js';
import type { AgentRunPhase } from './useWorkflowExecution.types.js';

interface OrchestratorPhaseUiState {
  status: WorkflowStatus;
  fsmState?: WorkflowFSMState;
  paused: boolean;
  runPhase: AgentRunPhase;
}

const ORCHESTRATOR_PHASE_LABELS: Record<string, string> = {
  boot: '启动探测',
  idle_probe_bd: '探测可恢复任务',
  resume_ask: '恢复确认',
  resume_plan: '加载恢复计划',
  idle: '空闲等待',
  intake: '需求接入',
  ask_switch: '冲突澄清',
  epic_sync: '同步任务模型',
  plan_baseline: '建立基线计划',
  plan_review: '计划评审',
  observe: '定义观察目标',
  research_fanout: '并发研究派发',
  wait_others: '等待研究结果',
  research_ingest: '回收研究产物',
  research_eval: '研究充分性评估',
  detail_design: '详细设计',
  coder_handoff: '交付编码任务',
  schedule: '资源调度',
  queue: '资源排队',
  dispatch: '派发执行',
  coder_exec: '编码执行',
  review_accept: '验收审核',
  replan_patch: '重规划修补',
  complete: '已完成',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
  understanding: '理解任务',
  high_design: '概要设计',
  deliverables: '交付清单',
  plan: '任务拆解',
  parallel_dispatch: '并行派发',
  blocked_review: '阻塞审查',
  verify: '验证交付',
  replanning: '重规划',
};

export function describeOrchestratorPhase(phase: string): string {
  const normalized = phase.trim().toLowerCase();
  if (!normalized) return '未知阶段';
  return ORCHESTRATOR_PHASE_LABELS[normalized] ?? normalized;
}

export function mapOrchestratorPhaseToUiState(phase: string): OrchestratorPhaseUiState {
  const normalized = phase.trim().toLowerCase();
  switch (normalized) {
    case 'idle':
      return { status: 'planning', fsmState: 'idle', paused: false, runPhase: 'idle' };
    case 'boot':
    case 'idle_probe_bd':
    case 'resume_plan':
      return { status: 'planning', fsmState: 'plan_loop', paused: false, runPhase: 'running' };
    case 'resume_ask':
    case 'ask_switch':
      return { status: 'paused', fsmState: 'wait_user_decision', paused: true, runPhase: 'idle' };
    case 'queue':
      return { status: 'paused', fsmState: 'paused', paused: true, runPhase: 'idle' };
    case 'review_accept':
    case 'verify':
      return { status: 'executing', fsmState: 'review', paused: false, runPhase: 'running' };
    case 'replan_patch':
    case 'replanning':
      return { status: 'executing', fsmState: 'replan_evaluation', paused: false, runPhase: 'running' };
    case 'schedule':
    case 'dispatch':
    case 'coder_exec':
    case 'parallel_dispatch':
    case 'blocked_review':
      return { status: 'executing', fsmState: 'execution', paused: false, runPhase: 'running' };
    case 'complete':
    case 'completed':
      return { status: 'completed', fsmState: 'completed', paused: false, runPhase: 'idle' };
    case 'failed':
      return { status: 'failed', fsmState: 'failed', paused: false, runPhase: 'error' };
    case 'cancelled':
      return { status: 'paused', fsmState: 'paused', paused: true, runPhase: 'idle' };
    default:
      return { status: 'planning', fsmState: 'plan_loop', paused: false, runPhase: 'running' };
  }
}
