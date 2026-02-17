/**
 * UnifiedEventBus - 统一事件总线
 * 支持本地订阅和 WebSocket 广播
 */

import { WebSocket } from 'ws';
import type { RuntimeEvent } from './events.js';

export type EventHandler = (event: RuntimeEvent) => void;

export interface EventBusStats {
  totalHandlers: number;
  wsClients: number;
  eventsEmitted: number;
}

export class UnifiedEventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wsClients = new Set<WebSocket>();
  private eventsEmitted = 0;
  private history: RuntimeEvent[] = [];
  private readonly maxHistory = 100;

  /**
   * 订阅特定类型事件
   * @returns 取消订阅函数
   */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    // 返回取消订阅函数
    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /**
   * 订阅多个事件类型
   * @returns 取消订阅函数
   */
  subscribeMultiple(eventTypes: string[], handler: EventHandler): () => void {
    const unsubscribers = eventTypes.map(type => this.subscribe(type, handler));
    return () => unsubscribers.forEach(unsub => unsub());
  }

  /**
   * 订阅所有事件
   * @returns 取消订阅函数
   */
  subscribeAll(handler: EventHandler): () => void {
    return this.subscribe('*', handler);
  }

  /**
   * 发送事件
   */
  emit(event: RuntimeEvent): void {
    this.eventsEmitted++;

    // 1. 保存到历史
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // 2. 触发特定类型订阅者
    const handlers = this.handlers.get(event.type);
    handlers?.forEach(h => {
      try {
        h(event);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${event.type}:`, err);
      }
    });

    // 3. 触发通配符订阅者
    const wildcardHandlers = this.handlers.get('*');
    wildcardHandlers?.forEach(h => {
      try {
        h(event);
      } catch (err) {
        console.error(`[EventBus] Wildcard handler error:`, err);
      }
    });

    // 4. 广播到 WebSocket 客户端
    const msg = JSON.stringify(event);
    this.wsClients.forEach(ws => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      } catch (err) {
        console.error(`[EventBus] WebSocket send error:`, err);
      }
    });
  }

  /**
   * 注册 WebSocket 客户端
   */
  registerWsClient(ws: WebSocket): void {
    this.wsClients.add(ws);

    ws.on('close', () => {
      this.wsClients.delete(ws);
    });

    ws.on('error', () => {
      this.wsClients.delete(ws);
    });
  }

  /**
   * 移除 WebSocket 客户端
   */
  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  /**
   * 获取事件历史
   */
  getHistory(limit?: number): RuntimeEvent[] {
    if (limit && limit < this.history.length) {
      return this.history.slice(-limit);
    }
    return [...this.history];
  }

  /**
   * 获取指定 session 的事件历史
   */
  getSessionHistory(sessionId: string, limit?: number): RuntimeEvent[] {
    const sessionEvents = this.history.filter(e => e.sessionId === sessionId);
    if (limit && limit < sessionEvents.length) {
      return sessionEvents.slice(-limit);
    }
    return sessionEvents;
  }

  /**
   * 清空历史
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * 获取统计信息
   */
  getStats(): EventBusStats {
    let totalHandlers = 0;
    for (const handlers of this.handlers.values()) {
      totalHandlers += handlers.size;
    }

    return {
      totalHandlers,
      wsClients: this.wsClients.size,
      eventsEmitted: this.eventsEmitted,
    };
  }

  /**
   * 清理所有订阅者
   */
  clear(): void {
    this.handlers.clear();
    this.wsClients.clear();
    this.history = [];
    this.eventsEmitted = 0;
  }
}

// 全局单例
export const globalEventBus = new UnifiedEventBus();
