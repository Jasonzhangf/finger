/**
 * Runtime Events - 统一事件模型
 * 所有 session/task/tool/dialog/progress/resource/human-in-loop 事件统一在此定义
 * 
 * 使用指南：
 * 1. UI 订阅：调用 globalEventBus.subscribeByGroup('HUMAN_IN_LOOP', handler)
 * 2. 服务器过滤：WebSocket 消息 { type: 'subscribe', groups: ['RESOURCE'], types: ['task_completed'] }
 * 3. 类型守卫：if (isResourceEvent(event)) { ... }
 */

import type { LoopEvent, EpicEvent, ContextEvent } from '../orchestration/loop/events.js';

// =============================================================================
// 基础类型定义
// =============================================================================

// 附件类型
export interface Attachment {
  id: string;
  name: string;
  type: 'image' | 'file' | 'code';
  url: string;
  size?: number;
}

// 基础事件接口
export interface BaseEvent {
  type: string;
  sessionId: string;
  timestamp: string;
}

// 用户决策选项
export interface UserDecisionOption {
  id: string;
  label: string;
  description?: string;
}

// =============================================================================
// Session 事件
// =============================================================================

export interface SessionCreatedEvent extends BaseEvent {
  type: 'session_created';
  payload: {
    name: string;
    projectPath: string;
    messageCount?: number;
  };
}

export interface SessionResumedEvent extends BaseEvent {
  type: 'session_resumed';
  payload: {
    checkpointId?: string;
    messageCount: number;
  };
}

export interface SessionPausedEvent extends BaseEvent {
  type: 'session_paused';
  payload: {
    reason?: string;
  };
}

export interface SessionCompressedEvent extends BaseEvent {
  type: 'session_compressed';
  payload: {
    originalSize: number;
    compressedSize: number;
    summary: string;
  };
}

export type SessionEvent =
  | SessionCreatedEvent
  | SessionResumedEvent
  | SessionPausedEvent
  | SessionCompressedEvent;

// =============================================================================
// Task 事件
// =============================================================================

export interface TaskStartedEvent extends BaseEvent {
  type: 'task_started';
  taskId: string;
  agentId?: string;
  payload: {
    title: string;
    description?: string;
    dependencies?: string[];
  };
}

export interface TaskProgressEvent extends BaseEvent {
  type: 'task_progress';
  taskId: string;
  agentId?: string;
  payload: {
    progress: number; // 0-100
    message?: string;
  };
}

export interface TaskCompletedEvent extends BaseEvent {
  type: 'task_completed';
  taskId: string;
  agentId?: string;
  payload: {
    result?: unknown;
    duration?: number; // ms
  };
}

export interface TaskFailedEvent extends BaseEvent {
  type: 'task_failed';
  taskId: string;
  agentId?: string;
  payload: {
    error: string;
    retryable?: boolean;
  };
}

export type TaskEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | TaskFailedEvent;

// =============================================================================
// Tool 事件
// =============================================================================

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  toolId: string;
  toolName: string;
  agentId: string;
  payload: {
    input: unknown;
  };
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolId: string;
  toolName: string;
  agentId: string;
  payload: {
    output: unknown;
    duration: number; // ms
  };
}

export interface ToolErrorEvent extends BaseEvent {
  type: 'tool_error';
  toolId: string;
  toolName: string;
  agentId: string;
  payload: {
    error: string;
    duration: number; // ms
  };
}

export type ToolEvent = ToolCallEvent | ToolResultEvent | ToolErrorEvent;

// =============================================================================
// Dialog 事件
// =============================================================================

export interface UserMessageEvent extends BaseEvent {
  type: 'user_message';
  payload: {
    messageId: string;
    content: string;
    attachments?: Attachment[];
  };
}

export interface AssistantChunkEvent extends BaseEvent {
  type: 'assistant_chunk';
  agentId: string;
  payload: {
    messageId: string;
    content: string;
  };
}

export interface AssistantCompleteEvent extends BaseEvent {
  type: 'assistant_complete';
  agentId: string;
  payload: {
    messageId: string;
    content: string;
    stopReason?: string;
  };
}

export type DialogEvent =
  | UserMessageEvent
  | AssistantChunkEvent
  | AssistantCompleteEvent;

// =============================================================================
// Progress 事件
// =============================================================================

export interface PlanUpdatedEvent extends BaseEvent {
  type: 'plan_updated';
  payload: {
    planId: string;
    version: number;
    taskCount: number;
    completedCount: number;
  };
}

export interface WorkflowProgressEvent extends BaseEvent {
  type: 'workflow_progress';
  payload: {
    overallProgress: number; // 0-100
    activeAgents: string[];
    pendingTasks: number;
    completedTasks: number;
    failedTasks: number;
  };
}

export type ProgressEvent = PlanUpdatedEvent | WorkflowProgressEvent;

// =============================================================================
// Phase 事件 - 编排者阶段流转
// =============================================================================

export interface PhaseTransitionEvent extends BaseEvent {
  type: 'phase_transition';
  agentId: string;
  payload: {
    from: string;
    to: string;
    triggerAction: string;
    checkpointId?: string;
    round: number;
  };
}

export interface PhaseOutputSavedEvent extends BaseEvent {
  type: 'phase_output_saved';
  agentId: string;
  payload: {
    phase: string;
    outputPath: string;
    files: string[];
  };
}

export interface DecisionTreeNodeEvent extends BaseEvent {
  type: 'decision_tree_node';
  agentId: string;
  payload: {
    phase: string;
    round: number;
    thought: string;
    action: string;
    params: Record<string, unknown>;
    observation?: string;
    outputFiles: string[];
  };
}

export type PhaseEvent = PhaseTransitionEvent | PhaseOutputSavedEvent | DecisionTreeNodeEvent;

// =============================================================================
// Resource 事件 - 资源池状态变化
// =============================================================================

export interface ResourceUpdateEvent extends BaseEvent {
  type: 'resource_update';
  payload: {
    resourceId: string;
    status: string;
    sessionId?: string;
    workflowId?: string;
  };
}

export interface ResourceShortageEvent extends BaseEvent {
  type: 'resource_shortage';
  taskId: string;
  payload: {
    missingResources: Array<{ type: string; capabilities?: string[] }>;
    reason: string;
    suggestion: string;
  };
}

export type ResourceEvent = ResourceUpdateEvent | ResourceShortageEvent;

// =============================================================================
// Human-in-Loop 事件 - 需要用户决策
// =============================================================================

export interface WaitingForUserEvent extends BaseEvent {
  type: 'waiting_for_user';
  workflowId: string;
  payload: {
    reason: 'resource_shortage' | 'confirmation_required' | 'ambiguous_input' | 'error_recovery';
    missingResources?: Array<{ type: string; capabilities?: string[] }>;
    suggestion?: string;
    options: UserDecisionOption[];
    context?: Record<string, unknown>;
  };
}

export interface UserDecisionReceivedEvent extends BaseEvent {
  type: 'user_decision_received';
  workflowId: string;
  payload: {
    decision: string;
    resources?: Array<{ id: string; capabilities: string[] }>;
    context?: Record<string, unknown>;
  };
}

export type HumanInLoopEvent = WaitingForUserEvent | UserDecisionReceivedEvent;

// =============================================================================
// System 事件
// =============================================================================

export interface SystemErrorEvent extends BaseEvent {
  type: 'system_error';
  payload: {
    error: string;
    component: string;
    recoverable: boolean;
  };
}

export type SystemEvent = SystemErrorEvent;

// =============================================================================
// 统一事件类型
// =============================================================================

export type RuntimeEvent =
  | SessionEvent
  | TaskEvent
  | ToolEvent
  | DialogEvent
  | ProgressEvent
  | PhaseEvent
  | ResourceEvent
  | HumanInLoopEvent
  | SystemEvent
  | LoopEvent
  | EpicEvent
  | ContextEvent;

// =============================================================================
// 事件类型常量定义（用于订阅过滤）
// =============================================================================

/** Session 事件类型集合 */
export const SESSION_EVENT_TYPES = [
  'session_created',
  'session_resumed',
  'session_paused',
  'session_compressed',
] as const;

/** Task 事件类型集合 */
export const TASK_EVENT_TYPES = [
  'task_started',
  'task_progress',
  'task_completed',
  'task_failed',
] as const;

/** Tool 事件类型集合 */
export const TOOL_EVENT_TYPES = [
  'tool_call',
  'tool_result',
  'tool_error',
] as const;

/** Dialog 事件类型集合 */
export const DIALOG_EVENT_TYPES = [
  'user_message',
  'assistant_chunk',
  'assistant_complete',
] as const;

/** Progress 事件类型集合 */
export const PROGRESS_EVENT_TYPES = [
  'plan_updated',
  'workflow_progress',
] as const;

/** Phase 事件类型集合 */
export const PHASE_EVENT_TYPES = [
  'phase_transition',
  'phase_output_saved',
  'decision_tree_node',
] as const;

/** Resource 事件类型集合 */
export const RESOURCE_EVENT_TYPES = [
  'resource_update',
  'resource_shortage',
] as const;

/** Human-in-Loop 事件类型集合 */
export const HUMAN_IN_LOOP_EVENT_TYPES = [
  'waiting_for_user',
  'user_decision_received',
] as const;

/** System 事件类型集合 */
export const SYSTEM_EVENT_TYPES = [
  'system_error',
] as const;

/** 事件分组 - UI 可按组订阅 */
export const EVENT_GROUPS = {
  SESSION: SESSION_EVENT_TYPES,
  TASK: TASK_EVENT_TYPES,
  TOOL: TOOL_EVENT_TYPES,
  DIALOG: DIALOG_EVENT_TYPES,
  PROGRESS: PROGRESS_EVENT_TYPES,
  PHASE: PHASE_EVENT_TYPES,
  RESOURCE: RESOURCE_EVENT_TYPES,
  HUMAN_IN_LOOP: HUMAN_IN_LOOP_EVENT_TYPES,
  SYSTEM: SYSTEM_EVENT_TYPES,
  ALL: [
    ...SESSION_EVENT_TYPES,
    ...TASK_EVENT_TYPES,
    ...TOOL_EVENT_TYPES,
    ...DIALOG_EVENT_TYPES,
    ...PROGRESS_EVENT_TYPES,
    ...PHASE_EVENT_TYPES,
    ...RESOURCE_EVENT_TYPES,
    ...HUMAN_IN_LOOP_EVENT_TYPES,
    ...SYSTEM_EVENT_TYPES,
  ] as const,
};

/** 获取所有支持的单个事件类型 */
export function getSupportedEventTypes(): string[] {
  return [...EVENT_GROUPS.ALL];
}

/** 获取所有支持的事件分组 */
export function getSupportedEventGroups(): string[] {
  return Object.keys(EVENT_GROUPS);
}

/** 根据分组名获取事件类型列表 */
export function getEventTypesByGroup(group: keyof typeof EVENT_GROUPS): readonly string[] {
  return EVENT_GROUPS[group] || [];
}

/** 检查事件类型是否属于某个分组 */
export function isEventInGroup(type: string, group: keyof typeof EVENT_GROUPS): boolean {
  return EVENT_GROUPS[group].includes(type as never);
}

// =============================================================================
// 事件类型守卫函数
// =============================================================================

export function isSessionEvent(event: RuntimeEvent): event is SessionEvent {
  return SESSION_EVENT_TYPES.includes(event.type as typeof SESSION_EVENT_TYPES[number]);
}

export function isTaskEvent(event: RuntimeEvent): event is TaskEvent {
  return TASK_EVENT_TYPES.includes(event.type as typeof TASK_EVENT_TYPES[number]);
}

export function isToolEvent(event: RuntimeEvent): event is ToolEvent {
  return TOOL_EVENT_TYPES.includes(event.type as typeof TOOL_EVENT_TYPES[number]);
}

export function isDialogEvent(event: RuntimeEvent): event is DialogEvent {
  return DIALOG_EVENT_TYPES.includes(event.type as typeof DIALOG_EVENT_TYPES[number]);
}

export function isProgressEvent(event: RuntimeEvent): event is ProgressEvent {
  return PROGRESS_EVENT_TYPES.includes(event.type as typeof PROGRESS_EVENT_TYPES[number]);
}

export function isPhaseEvent(event: RuntimeEvent): event is PhaseEvent {
  return PHASE_EVENT_TYPES.includes(event.type as typeof PHASE_EVENT_TYPES[number]);
}

export function isResourceEvent(event: RuntimeEvent): event is ResourceEvent {
  return RESOURCE_EVENT_TYPES.includes(event.type as typeof RESOURCE_EVENT_TYPES[number]);
}

export function isHumanInLoopEvent(event: RuntimeEvent): event is HumanInLoopEvent {
  return HUMAN_IN_LOOP_EVENT_TYPES.includes(event.type as typeof HUMAN_IN_LOOP_EVENT_TYPES[number]);
}

export function isSystemEvent(event: RuntimeEvent): event is SystemEvent {
  return SYSTEM_EVENT_TYPES.includes(event.type as typeof SYSTEM_EVENT_TYPES[number]);
}
