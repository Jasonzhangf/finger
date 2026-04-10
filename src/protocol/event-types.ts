/**
 * Event Types - 事件层类型定义（唯一真源）
 *
 * Event 是声明式语义：描述"发生了什么事实"
 * 必填字段：schemaVersion、eventId、type、actor、timestamp、correlationId、causationId、ownerWorkerId、payload
 *
 * @see Docs/operation-event-communication-architecture.md
 */

import type { AgentPath } from './operation-types.js';

// ─── Schema Version ─────────────────────────────────────────────

export type EventSchemaVersion = 'v1';

// ─── EventType 枚举 ──────────────────────────────────────────────

/**
 * 事件类型枚举
 */
export type EventType =
  // Turn 生命周期
  | 'turn_started'
  | 'turn_complete'
  | 'turn_aborted'
  | 'turn_failed'
  // Agent 状态
  | 'agent_status_changed'
  | 'agent_dispatch_queued'
  | 'agent_dispatch_started'
  | 'agent_dispatch_complete'
  | 'agent_dispatch_failed'
  | 'agent_dispatch_partial'  // 证据不足分支
  // 工具执行
  | 'tool_call_begin'
  | 'tool_call_end'
  | 'tool_call_failed'
  // 命令执行
  | 'exec_command_begin'
  | 'exec_command_output'
  | 'exec_command_end'
  // 状态变更
  | 'session_created'
  | 'session_switched'
  | 'session_compacted'
  | 'workflow_started'
  | 'workflow_complete'
  // 进度报告
  | 'progress_update'
  | 'reasoning_delta'
  | 'message_delta'
  // Review 阶段（System Coordinator）
  | 'review_started'
  | 'review_complete'
  | 'review_blocked';

/**
 * Event 分组（用于订阅过滤）
 */
export type EventGroup =
  | 'turn_lifecycle'    // turn_started/complete/aborted/failed
  | 'agent_status'      // agent_status_changed, dispatch_*
  | 'tool_execution'    // tool_call_*
  | 'command_execution' // exec_command_*
  | 'state_change'      // session_*, workflow_*
  | 'progress'          // progress_update, reasoning_delta, message_delta
  | 'review'            // review_*
  | 'all';              // 所有事件

// ─── Dispatch Status ────────────────────────────────────────────

/**
 * Dispatch 状态
 */
export type DispatchStatus =
  | 'queued'
  | 'started'
  | 'success'
  | 'failed'
  | 'partial'
  | 'closed'
  | 'retry';

/**
 * Dispatch 状态机约束
 *
 * - complete: 有完整 evidence + explored_paths → 可 closed
 * - failed: 有明确失败原因 + retry policy → 可 closed 或 retry
 * - partial: 无证据 → 必须等待用户决策或补充探索
 */
export interface DispatchClosureGate {
  /** 是否有完整证据 */
  hasEvidence: boolean;
  /** 是否有探索路径记录 */
  hasExploredPaths: boolean;
  /** 是否允许直接 closed */
  canClose: boolean;
  /** 阻塞原因（partial 时必填） */
  blockReason?: 'missing_evidence' | 'missing_explored_paths' | 'user_decision_required';
}

// ─── Event Schema ───────────────────────────────────────────────

/**
 * Event Schema（事件层）
 *
 * 必填字段：schemaVersion、eventId、type、actor、timestamp、correlationId、causationId、ownerWorkerId、payload
 */
export interface Event {
  /** Schema 版本（必填，用于兼容性） */
  schemaVersion: EventSchemaVersion;

  /** 唯一标识（必填） */
  eventId: string;

  /** 事件类型枚举（必填） */
  type: EventType;

  /** 发生者路径（必填） */
  actor: AgentPath;

  /** ISO8601 时间戳（必填） */
  timestamp: string;

  /** 关联请求 ID（必填，用于请求链路追踪） */
  correlationId: string;

  /** 因果 ID（必填，触发本事件的上游事件或操作） */
  causationId: string;

  /** 所属 worker（必填，用于 ownership 校验） */
  ownerWorkerId: string;

  /** 事件数据（必填） */
  payload: EventPayload;

  /** 关联的 Operation ID（可选但推荐） */
  relatedOpId?: string;

  /** 分布式追踪 ID（可选，用于跨系统追踪） */
  traceId?: string;
}

/**
 * Event Payload 类型映射
 */
export interface EventPayloadMap {
  turn_started: TurnStartedPayload;
  turn_complete: TurnCompletePayload;
  turn_aborted: TurnAbortedPayload;
  turn_failed: TurnFailedPayload;
  agent_status_changed: AgentStatusChangedPayload;
  agent_dispatch_queued: AgentDispatchQueuedPayload;
  agent_dispatch_started: AgentDispatchStartedPayload;
  agent_dispatch_complete: AgentDispatchCompletePayload;
  agent_dispatch_failed: AgentDispatchFailedPayload;
  agent_dispatch_partial: AgentDispatchPartialPayload;
  tool_call_begin: ToolCallBeginPayload;
  tool_call_end: ToolCallEndPayload;
  tool_call_failed: ToolCallFailedPayload;
  exec_command_begin: ExecCommandBeginPayload;
  exec_command_output: ExecCommandOutputPayload;
  exec_command_end: ExecCommandEndPayload;
  session_created: SessionCreatedPayload;
  session_switched: SessionSwitchedPayload;
  session_compacted: SessionCompactedPayload;
  workflow_started: WorkflowStartedPayload;
  workflow_complete: WorkflowCompletePayload;
  progress_update: ProgressUpdatePayload;
  reasoning_delta: ReasoningDeltaPayload;
  message_delta: MessageDeltaPayload;
  review_started: ReviewStartedPayload;
  review_complete: ReviewCompletePayload;
  review_blocked: ReviewBlockedPayload;
}

export type EventPayload = EventPayloadMap[EventType];

// ─── Payload 定义 ───────────────────────────────────────────────

export interface TurnStartedPayload {
  turnId: string;
  sessionId?: string;
  agentRole?: 'system' | 'project';
}

export interface TurnCompletePayload {
  turnId: string;
  sessionId?: string;
  status: 'success' | 'partial';
  evidence?: unknown;
  exploredPaths?: string[];
}

export interface TurnAbortedPayload {
  turnId: string;
  sessionId?: string;
  reason: 'user_interrupt' | 'timeout' | 'error' | 'cancelled';
}

export interface TurnFailedPayload {
  turnId: string;
  sessionId?: string;
  error: string;
  retryable?: boolean;
}

export interface AgentStatusChangedPayload {
  agentId: string;
  agentPath: AgentPath;
  oldStatus: 'idle' | 'busy' | 'error' | 'offline';
  newStatus: 'idle' | 'busy' | 'error' | 'offline';
  reason?: string;
}

export interface AgentDispatchQueuedPayload {
  dispatchId: string;
  taskId: string;
  queuePosition: number;
  sessionId?: string;
}

export interface AgentDispatchStartedPayload {
  dispatchId: string;
  taskId: string;
  attempt: number;
  sessionId?: string;
}

export interface AgentDispatchCompletePayload {
  dispatchId: string;
  taskId: string;
  attempt: number;
  status: 'success';
  evidence?: unknown;
  exploredPaths?: string[];
  durationMs?: number;
}

export interface AgentDispatchFailedPayload {
  dispatchId: string;
  taskId: string;
  attempt: number;
  error: string;
  retryPolicy?: {
    maxRetries: number;
    currentRetry: number;
    nextRetryDelayMs?: number;
  };
}

export interface AgentDispatchPartialPayload {
  dispatchId: string;
  taskId: string;
  attempt: number;
  /** 缺失的证据类型 */
  missingEvidence: ('execution_result' | 'file_change' | 'test_result' | 'user_confirmation')[];
  /** 缺失的探索路径 */
  missingExploredPaths?: boolean;
  /** 阻塞原因 */
  blockReason: 'missing_evidence' | 'missing_explored_paths' | 'user_decision_required';
  /** 用户决策选项 */
  userDecisionOptions?: ('continue_without_evidence' | 'retry' | 'abort')[];
}

export interface ToolCallBeginPayload {
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
}

export interface ToolCallEndPayload {
  toolCallId: string;
  toolName: string;
  result?: unknown;
  status: 'success' | 'error';
  error?: string;
}

export interface ToolCallFailedPayload {
  toolCallId: string;
  toolName: string;
  error: string;
  retryable?: boolean;
}

export interface ExecCommandBeginPayload {
  execId: string;
  command: string;
  cwd?: string;
}

export interface ExecCommandOutputPayload {
  execId: string;
  output: string;
  stream: 'stdout' | 'stderr';
}

export interface ExecCommandEndPayload {
  execId: string;
  exitCode: number;
  signal?: string;
}

export interface SessionCreatedPayload {
  sessionId: string;
  sessionPath: AgentPath;
  source: 'cli' | 'webui' | 'vscode' | 'heartbeat' | 'subagent';
  ownerWorkerId: string;
}

export interface SessionSwitchedPayload {
  oldSessionId?: string;
  newSessionId: string;
  sessionPath: AgentPath;
  reason: 'user_request' | 'task_assignment' | 'context_overflow';
}

export interface SessionCompactedPayload {
  sessionId: string;
  compactedLines: number;
  savedTokens: number;
  compactType: 'auto' | 'manual';
}

export interface WorkflowStartedPayload {
  workflowId: string;
  workflowName: string;
  taskId?: string;
}

export interface WorkflowCompletePayload {
  workflowId: string;
  workflowName: string;
  status: 'success' | 'failed' | 'partial';
  evidence?: unknown;
}

export interface ProgressUpdatePayload {
  dispatchId: string;
  progress: number;  // 0-100
  message: string;
  stage?: string;
}

export interface ReasoningDeltaPayload {
  dispatchId: string;
  delta: string;
  isComplete?: boolean;
}

export interface MessageDeltaPayload {
  dispatchId: string;
  delta: string;
  isComplete?: boolean;
}

export interface ReviewStartedPayload {
  dispatchId: string;
  reviewType: 'code' | 'design' | 'task_completion';
  reviewerPath: AgentPath;
}

export interface ReviewCompletePayload {
  dispatchId: string;
  reviewType: 'code' | 'design' | 'task_completion';
  result: 'approved' | 'rejected' | 'needs_changes';
  feedback?: string;
}

export interface ReviewBlockedPayload {
  dispatchId: string;
  reviewType: 'code' | 'design' | 'task_completion';
  blockReason: 'missing_context' | 'ambiguous_result' | 'user_input_required';
}

// ─── Event 工具函数 ─────────────────────────────────────────────

export const EventUtils = {
  /**
   * 创建 Event ID
   */
  generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  },

  /**
   * 创建基础 Event
   */
  create(
    type: EventType,
    actor: AgentPath,
    payload: EventPayload,
    correlationId: string,
    causationId: string,
    ownerWorkerId: string,
    options?: {
      relatedOpId?: string;
      traceId?: string;
    },
  ): Event {
    return {
      schemaVersion: 'v1',
      eventId: this.generateEventId(),
      type,
      actor,
      payload,
      timestamp: new Date().toISOString(),
      correlationId,
      causationId,
      ownerWorkerId,
      ...options,
    };
  },

  /**
   * 验证 Event 必填字段
   */
  validate(event: Event): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    if (!event.schemaVersion) missing.push('schemaVersion');
    if (!event.eventId) missing.push('eventId');
    if (!event.type) missing.push('type');
    if (!event.actor) missing.push('actor');
    if (!event.timestamp) missing.push('timestamp');
    if (!event.correlationId) missing.push('correlationId');
    if (!event.causationId) missing.push('causationId');
    if (!event.ownerWorkerId) missing.push('ownerWorkerId');
    if (!event.payload) missing.push('payload');
    return { valid: missing.length === 0, missing };
  },

  /**
   * 计算 Dedup Key
   * dedupKey = eventType + dispatchId + taskId + attempt + turnId
   */
  computeDedupKey(event: Event): string {
    
    const parts = [
      event.type,
      (event.payload as any).dispatchId || '',
      (event.payload as any).taskId || '',
      (event.payload as any).attempt || '',
      (event.payload as any).turnId || '',
    ];
    return parts.join(':');
  },

  /**
   * 判断 Event 是否属于某分组
   */
  belongsToGroup(type: EventType, group: EventGroup): boolean {
    const groupMap: Record<EventGroup, EventType[]> = {
      turn_lifecycle: ['turn_started', 'turn_complete', 'turn_aborted', 'turn_failed'],
      agent_status: [
        'agent_status_changed',
        'agent_dispatch_queued',
        'agent_dispatch_started',
        'agent_dispatch_complete',
        'agent_dispatch_failed',
        'agent_dispatch_partial',
      ],
      tool_execution: ['tool_call_begin', 'tool_call_end', 'tool_call_failed'],
      command_execution: ['exec_command_begin', 'exec_command_output', 'exec_command_end'],
      state_change: [
        'session_created',
        'session_switched',
        'session_compacted',
        'workflow_started',
        'workflow_complete',
      ],
      progress: ['progress_update', 'reasoning_delta', 'message_delta'],
      review: ['review_started', 'review_complete', 'review_blocked'],
      all: [],  // 特殊处理
    };

    if (group === 'all') return true;
    return groupMap[group]?.includes(type) ?? false;
  },

  /**
   * 判断 Dispatch 是否允许 closed
   */
  canCloseDispatch(payload: AgentDispatchCompletePayload | AgentDispatchPartialPayload): DispatchClosureGate {
    const completePayload = payload as AgentDispatchCompletePayload;
    const hasEvidence = completePayload.evidence !== undefined && completePayload.evidence !== null;
    const hasExploredPaths = completePayload.exploredPaths !== undefined && completePayload.exploredPaths.length > 0;

    if ('status' in payload && payload.status === 'success') {
      return { hasEvidence, hasExploredPaths, canClose: true };
    }

    // partial 分支
    const partialPayload = payload as AgentDispatchPartialPayload;
    const canClose = partialPayload.userDecisionOptions?.includes('continue_without_evidence') ?? false;

    return {
      hasEvidence,
      hasExploredPaths,
      canClose,
      blockReason: partialPayload.blockReason,
    };
  },
};
