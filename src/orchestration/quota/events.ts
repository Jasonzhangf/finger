/**
 * Runtime Events - Runtime 生命周期事件
 * 
 * Phase 1 事件定义：runtime_spawned, runtime_status_changed, runtime_finished
 */

import type { RuntimeStatus, RuntimeInstanceV1 } from './types.js';

/**
 * Runtime 事件类型
 */
export type RuntimeEventType =
  | 'runtime_spawned'
  | 'runtime_status_changed'
  | 'runtime_finished';

/**
 * Runtime 事件基础接口
 */
export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: number;
  instanceId: string;
  agentConfigId: string;
}

/**
 * Runtime 创建事件
 */
export interface RuntimeSpawnedEvent extends RuntimeEvent {
  type: 'runtime_spawned';
  workflowId?: string;
  taskId?: string;
  queuePosition?: number;
  queuedCount?: number;
}

/**
 * Runtime 状态变更事件
 */
export interface RuntimeStatusChangedEvent extends RuntimeEvent {
  type: 'runtime_status_changed';
  previousStatus: RuntimeStatus;
  currentStatus: RuntimeStatus;
  summary?: string;
  pid?: number;
  port?: number;
}

/**
 * Runtime 结束事件
 */
export interface RuntimeFinishedEvent extends RuntimeEvent {
  type: 'runtime_finished';
  finalStatus: 'completed' | 'failed' | 'interrupted';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  errorReason?: string;
  summary?: string;
}

/**
 * 事件发射器
 */
type EventListener = (event: RuntimeEvent) => void;

class RuntimeEventEmitter {
  private listeners: Map<RuntimeEventType, Set<EventListener>> = new Map();

  on(eventType: RuntimeEventType, listener: EventListener): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(listener);
  }

  off(eventType: RuntimeEventType, listener: EventListener): void {
    this.listeners.get(eventType)?.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    const listeners = this.listeners.get(event.type);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(event);
        } catch (err) {
          console.error(`[RuntimeEventEmitter] Error in listener for ${event.type}:`, err);
        }
      });
    }
  }
}

export const runtimeEventEmitter = new RuntimeEventEmitter();

/**
 * 创建 runtime_spawned 事件
 */
export function createSpawnedEvent(instance: RuntimeInstanceV1): RuntimeSpawnedEvent {
  return {
    type: 'runtime_spawned',
    timestamp: Date.now(),
    instanceId: instance.instanceId,
    agentConfigId: instance.agentConfigId,
    workflowId: instance.workflowId,
    taskId: instance.taskId,
    queuePosition: instance.queuePosition,
    queuedCount: instance.queuedCount,
  };
}

/**
 * 创建 runtime_status_changed 事件
 */
export function createStatusChangedEvent(
  instance: RuntimeInstanceV1,
  previousStatus: RuntimeStatus
): RuntimeStatusChangedEvent {
  return {
    type: 'runtime_status_changed',
    timestamp: Date.now(),
    instanceId: instance.instanceId,
    agentConfigId: instance.agentConfigId,
    previousStatus,
    currentStatus: instance.status,
    summary: instance.summary,
    pid: instance.pid,
    port: instance.port,
  };
}

/**
 * 创建 runtime_finished 事件
 */
export function createFinishedEvent(
  instance: RuntimeInstanceV1
): RuntimeFinishedEvent {
  const startedAt = instance.startedAt ?? Date.now();
  const endedAt = instance.endedAt ?? Date.now();
  
  return {
    type: 'runtime_finished',
    timestamp: endedAt,
    instanceId: instance.instanceId,
    agentConfigId: instance.agentConfigId,
    finalStatus: instance.finalStatus ?? 'completed',
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    errorReason: instance.errorReason,
    summary: instance.summary,
  };
}
