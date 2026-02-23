/**
 * UnifiedEventBus - 统一事件总线
 * 支持按类型/按组订阅、WebSocket 广播、事件历史查询
 * 
 * 使用指南：
 * 1. 订阅单类型：bus.subscribe('task_completed', handler)
 * 2. 订阅多类型：bus.subscribeMultiple(['task_started', 'task_completed'], handler)
 * 3. 订阅分组：bus.subscribeByGroup('HUMAN_IN_LOOP', handler) 或 bus.subscribeByGroup('RESOURCE', handler)
 * 4. 订阅所有：bus.subscribeAll(handler)
 */

import { WebSocket } from 'ws';
// import { performanceMonitor } from './performance-monitor.js';
import type { RuntimeEvent } from './events.js';
import { EVENT_GROUPS, getEventTypesByGroup, getSupportedEventGroups } from './events.js';
import { getSupportedEventTypes } from './events.js';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

export type EventHandler = (event: RuntimeEvent) => void;

export interface EventBusStats {
  totalHandlers: number;
  wsClients: number;
  eventsEmitted: number;
  persistenceEnabled: boolean;
}

export class UnifiedEventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wsClients = new Set<WebSocket>();
  private eventsEmitted = 0;
  private history: RuntimeEvent[] = [];
  private readonly maxHistory = 100;
  
  // 持久化配置
  private persistenceEnabled = false;
  private persistenceDir = '';
  private sessionId: string | null = null;

  /**
   * 订阅特定类型事件
   * @returns 取消订阅函数
   */
  subscribe(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
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
   * 按分组订阅事件
   * @param group 分组名（如 'HUMAN_IN_LOOP', 'RESOURCE', 'TASK' 等）
   * @param handler 事件处理函数
   * @returns 取消订阅函数
   */
  subscribeByGroup(group: keyof typeof EVENT_GROUPS, handler: EventHandler): () => void {
    const types = getEventTypesByGroup(group);
    return this.subscribeMultiple([...types], handler);
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
  async emit(event: RuntimeEvent): Promise<void> {
    this.eventsEmitted++;

    // 1. 保存到内存历史
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // 2. 持久化到文件（如果启用）
    if (this.persistenceEnabled && this.sessionId) {
      await this.persistEvent(event);
    }

    // 3. 触发特定类型订阅者
    const handlers = this.handlers.get(event.type);
    handlers?.forEach(h => {
      try {
        h(event);
      } catch (err) {
        console.error(`[EventBus] Handler error for ${event.type}:`, err);
      }
    });

    // 4. 触发通配符订阅者
    const wildcardHandlers = this.handlers.get('*');
    wildcardHandlers?.forEach(h => {
      try {
        h(event);
      } catch (err) {
        console.error(`[EventBus] Wildcard handler error:`, err);
      }
    });

    // 5. 广播到 WebSocket 客户端（服务端过滤）n    const broadcastStart = Date.now();n    this.broadcastToWsClients(event);n    const broadcastTime = Date.now() - broadcastStart;nn    // 6. 记录性能指标n    performanceMonitor.recordEvent(1, broadcastTime);
  }

  /**
   * 广播事件到 WebSocket 客户端（带订阅过滤）
   */
  private broadcastToWsClients(event: RuntimeEvent): void {
    const msg = JSON.stringify(event);
    console.log(`[EventBus] Broadcasting event: ${event.type}`, JSON.stringify(event).substring(0, 200));
    this.wsClients.forEach(ws => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          // 检查客户端订阅过滤
          const filter = (ws as WebSocket & { eventFilter?: { types?: string[]; groups?: string[] } }).eventFilter;
          if (filter) {
            const { types, groups } = filter;
            let shouldSend = false;
            
            // 如果订阅了特定类型
            if (types && types.includes(event.type)) {
              shouldSend = true;
            }
            
            // 如果订阅了分组，检查事件是否属于该分组
            if (groups && !shouldSend) {
              for (const group of groups) {
                const groupTypes = getEventTypesByGroup(group as keyof typeof EVENT_GROUPS);
                if (groupTypes.includes(event.type)) {
                  shouldSend = true;
                  break;
                }
              }
            }
            
            if (!shouldSend) return;
          }
          
          console.log(`[EventBus] Sending to client: ${event.type}`);
          ws.send(msg);
        }
      } catch (err) {
        console.error(`[EventBus] WebSocket send error:`, err);
      }
    });
  }

  /**
   * 注册 WebSocket 客户端（支持订阅过滤）
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
   * 设置 WebSocket 客户端的事件过滤
   */
  setWsClientFilter(ws: WebSocket, filter: { types?: string[]; groups?: string[] }): void {
    (ws as WebSocket & { eventFilter?: { types?: string[]; groups?: string[] } }).eventFilter = filter;
  }

  /**
   * 移除 WebSocket 客户端
   */
  removeWsClient(ws: WebSocket): void {
    this.wsClients.delete(ws);
  }

  /**
   * 启用事件持久化
   * @param sessionId 会话 ID（用于生成日志文件名）
   * @param logsDir 日志目录（默认 logs/events）
   */
  enablePersistence(sessionId: string, logsDir?: string): void {
    this.sessionId = sessionId;
    this.persistenceDir = logsDir || join(process.cwd(), 'logs', 'events');
    this.persistenceEnabled = true;
    
    mkdir(this.persistenceDir, { recursive: true }).catch(() => {});
  }

  /**
   * 禁用事件持久化
   */
  disablePersistence(): void {
    this.persistenceEnabled = false;
  }

  /**
   * 持久化事件到文件
   */
  private async persistEvent(event: RuntimeEvent): Promise<void> {
    try {
      const logFile = join(this.persistenceDir, `${this.sessionId}-events.jsonl`);
      await appendFile(logFile, JSON.stringify(event) + '\n');
    } catch (err) {
      console.error('[EventBus] Persist event error:', err);
    }
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
   * 按类型获取事件历史
   */
  getHistoryByType(type: string, limit?: number): RuntimeEvent[] {
    const filtered = this.history.filter(e => e.type === type);
    if (limit && limit < filtered.length) {
      return filtered.slice(-limit);
    }
    return filtered;
  }

  /**
   * 按分组获取事件历史
   */
  getHistoryByGroup(group: keyof typeof EVENT_GROUPS, limit?: number): RuntimeEvent[] {
    const types = getEventTypesByGroup(group);
    const filtered = this.history.filter(e => types.includes(e.type));
    if (limit && limit < filtered.length) {
      return filtered.slice(-limit);
    }
    return filtered;
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
      persistenceEnabled: this.persistenceEnabled,
    };
  }

 /**
  * 获取支持的分组列表
  */
 getSupportedGroups(): string[] {
   return getSupportedEventGroups();
 }

  /**
   * 获取支持的事件类型列表
   */
  getSupportedTypes(): string[] {
    return getSupportedEventTypes();
  }

  /**
   * 清理所有订阅者
   */
  clear(): void {
    this.handlers.clear();
    this.wsClients.clear();
    this.history = [];
    this.eventsEmitted = 0;
    this.persistenceEnabled = false;
  }
}

// 全局单例
export const globalEventBus = new UnifiedEventBus();
