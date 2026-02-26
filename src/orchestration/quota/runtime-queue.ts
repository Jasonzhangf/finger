/**
 * Runtime Queue - Runtime 实例队列管理
 * 
 * Phase 1 串行验证：管理 runtime 实例的排队、出队、状态追踪
 */

import type { RuntimeInstanceV1, RuntimeStatus } from './types.js';

/**
 * 队列项
 */
interface QueueItem {
  instance: RuntimeInstanceV1;
  enqueuedAt: number;
  priority: number;
}

/**
 * Runtime 队列管理器
 */
export class RuntimeQueue {
  private queue: QueueItem[] = [];
  private active: Map<string, RuntimeInstanceV1> = new Map();
  private completed: Map<string, RuntimeInstanceV1> = new Map();
  private maxConcurrent: number = 1; // Phase 1 强制串行

  /**
   * 设置最大并发数
   */
  setMaxConcurrent(max: number): void {
    this.maxConcurrent = max;
  }

  /**
   * 获取当前最大并发数
   */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * 将 runtime 实例加入队列
   */
  enqueue(instance: RuntimeInstanceV1, priority: number = 5): number {
    const item: QueueItem = {
      instance: {
        ...instance,
        status: 'queued',
      },
      enqueuedAt: Date.now(),
      priority,
    };

    this.queue.push(item);
    this.updateQueuePositions();
    
    return this.queue.length;
  }

  /**
   * 尝试出队（如果有空位）
   */
  tryDequeue(): RuntimeInstanceV1 | null {
    if (this.active.size >= this.maxConcurrent) {
      return null;
    }

    if (this.queue.length === 0) {
      return null;
    }

    // FIFO 出队（Phase 1 串行模式）
    const item = this.queue.shift()!;
    const instance: RuntimeInstanceV1 = {
      ...item.instance,
      status: 'running',
      startedAt: Date.now(),
      queuePosition: undefined,
    };

    this.active.set(instance.instanceId, instance);
    this.updateQueuePositions();

    return instance;
  }

  /**
   * 标记实例完成
   */
  complete(instanceId: string, finalStatus: 'completed' | 'failed' | 'interrupted', errorReason?: string): void {
    const instance = this.active.get(instanceId);
    if (!instance) {
      console.warn(`[RuntimeQueue] Instance ${instanceId} not found in active set`);
      return;
    }

    const completedInstance: RuntimeInstanceV1 = {
      ...instance,
      status: finalStatus,
      endedAt: Date.now(),
      finalStatus,
      errorReason,
    };

    this.active.delete(instanceId);
    this.completed.set(instanceId, completedInstance);
  }

  /**
   * 获取队列状态
   */
  getStats(): {
    queued: number;
    active: number;
    completed: number;
    maxConcurrent: number;
  } {
    return {
      queued: this.queue.length,
      active: this.active.size,
      completed: this.completed.size,
      maxConcurrent: this.maxConcurrent,
    };
  }

  /**
   * 获取队列中的所有实例
   */
  getQueued(): RuntimeInstanceV1[] {
    return this.queue.map(item => item.instance);
  }

  /**
   * 获取运行中的所有实例
   */
  getActive(): RuntimeInstanceV1[] {
    return Array.from(this.active.values());
  }

  /**
   * 获取已完成的实例
   */
  getCompleted(): RuntimeInstanceV1[] {
    return Array.from(this.completed.values());
  }

  /**
   * 获取指定实例
   */
  getInstance(instanceId: string): RuntimeInstanceV1 | undefined {
    return this.active.get(instanceId) 
      ?? this.completed.get(instanceId)
      ?? this.queue.find(item => item.instance.instanceId === instanceId)?.instance;
  }

  /**
   * 更新实例状态
   */
  updateStatus(instanceId: string, status: RuntimeStatus, summary?: string): boolean {
    // 检查 active
    const activeInstance = this.active.get(instanceId);
    if (activeInstance) {
      this.active.set(instanceId, {
        ...activeInstance,
        status,
        summary: summary ?? activeInstance.summary,
      });
      return true;
    }

    // 检查 queue
    const queueItem = this.queue.find(item => item.instance.instanceId === instanceId);
    if (queueItem) {
      queueItem.instance.status = status;
      queueItem.instance.summary = summary ?? queueItem.instance.summary;
      return true;
    }

    return false;
  }

  /**
   * 更新队列位置
   */
  private updateQueuePositions(): void {
    const queuedCount = this.queue.length;
    this.queue.forEach((item, index) => {
      item.instance.queuePosition = index + 1;
      item.instance.queuedCount = queuedCount;
    });
  }

  /**
   * 清空已完成记录
   */
  clearCompleted(): void {
    this.completed.clear();
  }

  /**
   * 重置队列
   */
  reset(): void {
    this.queue = [];
    this.active.clear();
    this.completed.clear();
  }
}

// 单例
export const runtimeQueue = new RuntimeQueue();
