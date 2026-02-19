/**
 * Runtime Events - 统一事件模型
 * 所有 session/task/tool/dialog/progress 事件统一在此定义
 */

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

// Session 事件
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

// Task 事件
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

// Tool 事件
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

// Dialog 事件
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

// Progress 事件
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

// 统一事件类型
export type RuntimeEvent =
  | SessionEvent
  | TaskEvent
  | ToolEvent
  | DialogEvent
  | ProgressEvent;

// 事件类型集合 (用于订阅过滤)
export const EventTypes = {
  SESSION: ['session_created', 'session_resumed', 'session_paused', 'session_compressed'] as const,
  TASK: ['task_started', 'task_progress', 'task_completed', 'task_failed'] as const,
  TOOL: ['tool_call', 'tool_result', 'tool_error'] as const,
  DIALOG: ['user_message', 'assistant_chunk', 'assistant_complete'] as const,
  PROGRESS: ['plan_updated', 'workflow_progress'] as const,
} as const;

// 事件类型守卫函数
export function isSessionEvent(event: RuntimeEvent): event is SessionEvent {
  return EventTypes.SESSION.includes(event.type as typeof EventTypes.SESSION[number]);
}

export function isTaskEvent(event: RuntimeEvent): event is TaskEvent {
  return EventTypes.TASK.includes(event.type as typeof EventTypes.TASK[number]);
}

export function isToolEvent(event: RuntimeEvent): event is ToolEvent {
  return EventTypes.TOOL.includes(event.type as typeof EventTypes.TOOL[number]);
}

export function isDialogEvent(event: RuntimeEvent): event is DialogEvent {
  return EventTypes.DIALOG.includes(event.type as typeof EventTypes.DIALOG[number]);
}

export function isProgressEvent(event: RuntimeEvent): event is ProgressEvent {
  return EventTypes.PROGRESS.includes(event.type as typeof EventTypes.PROGRESS[number]);
}
