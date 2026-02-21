/**
 * Loop 循环事件定义
 * 扩展 runtime/events.ts，支持循环生命周期事件
 */

import type { BaseEvent } from '../../runtime/events.js';
import type { Loop, LoopNode, LoopPhase, LoopResult, LoopStatus, PendingUserInput, ResourceAllocationInfo } from './types.js';

// =============================================================================
// 循环事件
// =============================================================================

export interface LoopCreatedEvent extends BaseEvent {
  type: 'loop.created';
  epicId: string;
  payload: {
    loop: Loop;
  };
}

export interface LoopStartedEvent extends BaseEvent {
  type: 'loop.started';
  epicId: string;
  loopId: string;
  payload: {
    loopId: string;
    phase: LoopPhase;
  };
}

export interface LoopNodeUpdatedEvent extends BaseEvent {
  type: 'loop.node.updated';
  epicId: string;
  loopId: string;
  nodeId: string;
  payload: {
    node: LoopNode;
    previousStatus?: string;
  };
}

export interface LoopNodeCompletedEvent extends BaseEvent {
  type: 'loop.node.completed';
  epicId: string;
  loopId: string;
  nodeId: string;
  payload: {
    result: 'success' | 'failed';
    node: LoopNode;
  };
}

export interface LoopCompletedEvent extends BaseEvent {
  type: 'loop.completed';
  epicId: string;
  payload: {
    loop: Loop;
    result: LoopResult;
    newLoopId?: string; // 如果触发了新循环
  };
}

export interface LoopQueuedEvent extends BaseEvent {
  type: 'loop.queued';
  epicId: string;
  payload: {
    loop: Loop;
    sourceLoopId: string;
  };
}

// =============================================================================
// Epic 阶段事件
// =============================================================================

export interface EpicPhaseTransitionEvent extends BaseEvent {
  type: 'epic.phase_transition';
  epicId: string;
  payload: {
    from: LoopPhase | 'completed' | 'failed';
    to: LoopPhase | 'completed' | 'failed';
    reason: string;
    loopId?: string;
  };
}

export interface EpicUserInputRequiredEvent extends BaseEvent {
  type: 'epic.user_input_required';
  epicId: string;
  payload: PendingUserInput;
}

export interface EpicCreatedEvent extends BaseEvent {
  type: 'epic.created';
  payload: {
    epicId: string;
    title: string;
    description: string;
  };
}

export interface EpicCompletedEvent extends BaseEvent {
  type: 'epic.completed';
  epicId: string;
  payload: {
    success: boolean;
    summary: string;
    deliverables?: string[];
  };
}

// =============================================================================
// 资源事件
// =============================================================================

export interface ResourceAllocatedEvent extends BaseEvent {
  type: 'resource.allocated';
  taskId: string;
  payload: ResourceAllocationInfo;
}

export interface ResourceReleasedEvent extends BaseEvent {
  type: 'resource.released';
  taskId: string;
  payload: {
    resources: string[];
    reason: 'completed' | 'failed' | 'blocked' | 'cancelled';
  };
}

// =============================================================================
// 上下文压缩事件
// =============================================================================

export interface ContextCompressedEvent extends BaseEvent {
  type: 'context.compressed';
  sessionId: string;
  payload: {
    originalTokens: number;
    compressedTokens: number;
    preservedCycles: number;
    trigger: 'cycle_complete' | 'token_threshold' | 'both';
  };
}

// =============================================================================
// 事件类型汇总
// =============================================================================

export type LoopEvent =
  | LoopCreatedEvent
  | LoopStartedEvent
  | LoopNodeUpdatedEvent
  | LoopNodeCompletedEvent
  | LoopCompletedEvent
  | LoopQueuedEvent;

export type EpicEvent =
  | EpicPhaseTransitionEvent
  | EpicUserInputRequiredEvent
  | EpicCreatedEvent
  | EpicCompletedEvent;

export type ResourceEvent =
  | ResourceAllocatedEvent
  | ResourceReleasedEvent;

export type ContextEvent =
  | ContextCompressedEvent;

// 所有新增事件
export type NewEvent =
  | LoopEvent
  | EpicEvent
  | ResourceEvent
  | ContextEvent;

// =============================================================================
// 事件分组（扩展 EVENT_GROUPS）
// =============================================================================

export const LOOP_EVENT_TYPES = [
  'loop.created',
  'loop.started',
  'loop.node.updated',
  'loop.node.completed',
  'loop.completed',
  'loop.queued',
] as const;

export const EPIC_EVENT_TYPES = [
  'epic.phase_transition',
  'epic.user_input_required',
  'epic.created',
  'epic.completed',
] as const;

export const RESOURCE_EVENT_TYPES = [
  'resource.allocated',
  'resource.released',
] as const;

export const CONTEXT_EVENT_TYPES = [
  'context.compressed',
] as const;

// =============================================================================
// 类型守卫
// =============================================================================

export function isLoopEvent(event: BaseEvent & { type: string }): event is LoopEvent {
  return LOOP_EVENT_TYPES.includes(event.type as typeof LOOP_EVENT_TYPES[number]);
}

export function isEpicEvent(event: BaseEvent & { type: string }): event is EpicEvent {
  return EPIC_EVENT_TYPES.includes(event.type as typeof EPIC_EVENT_TYPES[number]);
}

export function isResourceEvent(event: BaseEvent & { type: string }): event is ResourceEvent {
  return RESOURCE_EVENT_TYPES.includes(event.type as typeof RESOURCE_EVENT_TYPES[number]);
}

export function isContextEvent(event: BaseEvent & { type: string }): event is ContextEvent {
  return CONTEXT_EVENT_TYPES.includes(event.type as typeof CONTEXT_EVENT_TYPES[number]);
}
