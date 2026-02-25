/**
 * 消息中枢 - 核心消息路由器
 * 负责所有组件之间的消息路由，支持阻塞/非阻塞模式
 * 集成错误处理和结构化日志
 */

import { logger } from '../core/logger.js';
import { errorHandler } from './error-handler.js';

export type Message = unknown;
export type MessageHandler = (message: Message) => Promise<unknown> | unknown;
export type MessageCallback = (result: unknown) => void;

/**
 * 路由规则条目
 */
export interface RouteEntry {
  id: string;
  pattern: string | RegExp | ((message: Message) => boolean);
  handler: MessageHandler;
  blocking: boolean;
  priority: number;
  description?: string;
  moduleId?: string;
}

/**
 * 输入接口注册信息
 */
export interface InputRegistration {
  id: string;
  handler: MessageHandler;
  routes: string[];
}

/**
 * 输出接口注册信息
 */
export interface OutputRegistration {
  id: string;
  handler: (message: Message, callback?: MessageCallback) => Promise<unknown>;
}

/**
 * 消息队列条目
 */
interface QueueItem {
  message: Message;
  callback?: MessageCallback;
  timestamp: number;
}

/**
 * 消息中枢类
 */
export class MessageHub {
  private routes: RouteEntry[] = [];
  private inputs: Map<string, InputRegistration> = new Map();
  private outputs: Map<string, OutputRegistration> = new Map();
  private pendingCallbacks: Map<string, MessageCallback> = new Map();
  private messageQueue: QueueItem[] = [];
  private nextCallbackId = 1;
  private log = logger.module('MessageHub');

  registerInput(id: string, handler: MessageHandler, routes: string[] = []): void {
    this.inputs.set(id, { id, handler, routes });
    this.log.info('Input registered', { id, routes });
  }

  registerOutput(id: string, handler: (message: Message, callback?: MessageCallback) => Promise<unknown>): void {
    this.outputs.set(id, { id, handler });
    this.log.info('Output registered', { id });
  }

  getInputs(): InputRegistration[] {
    return Array.from(this.inputs.values());
  }

  getOutputs(): OutputRegistration[] {
    return Array.from(this.outputs.values());
  }

  getRoutes(): RouteEntry[] {
    return [...this.routes];
  }

  addRoute(route: Omit<RouteEntry, 'id'> & { id?: string }): string {
    const id = route.id || 'route-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    this.routes.push({ ...route, id } as RouteEntry);
    this.routes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.log.info('Route added', { id, priority: route.priority, moduleId: route.moduleId });
    return id;
  }

  removeRoute(id: string): boolean {
    const index = this.routes.findIndex(r => r.id === id);
    if (index >= 0) {
      this.routes.splice(index, 1);
      this.log.info('Route removed', { id });
      return true;
    }
    return false;
  }

  async send(message: Message, callback?: MessageCallback): Promise<unknown> {
    const matchingRoutes = this.routes.filter(r => {
      const msg = message as Record<string, unknown>;
      
      if (typeof r.pattern === 'function') {
        return r.pattern(message);
      }
      if (r.pattern instanceof RegExp) {
        return r.pattern.test(JSON.stringify(message));
      }
      
      return msg.type === r.pattern || msg.route === r.pattern;
    });

    if (matchingRoutes.length === 0) {
      this.messageQueue.push({ message, callback, timestamp: Date.now() });
      this.log.info('No matching route, message queued', { queueLength: this.messageQueue.length });
      return { queued: true, queueLength: this.messageQueue.length };
    }

    let lastResult: unknown;
    
    for (const route of matchingRoutes) {
      const moduleId = route.moduleId || route.id;
      
      try {
        const result = await route.handler(message);
        lastResult = result;
        
        if (callback) {
          callback(result);
        }
        
        if (route.blocking) {
          this.log.info('Blocking route handled', { moduleId, routeId: route.id });
          return result;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('Route handler error', error, { moduleId, routeId: route.id });
        
        if (route.blocking) {
          const retryFn = async (): Promise<void> => {
            await route.handler(message);
          };
          
          const errorResult = await errorHandler.handleError(error, moduleId, retryFn);
          
          if (errorResult.paused) {
            return { 
              error: true, 
              paused: true, 
              reason: errorResult.reason,
              routeId: route.id 
            };
          }
          
          return { 
            retryScheduled: true, 
            moduleId,
            routeId: route.id 
          };
        }
      }
    }

    return lastResult;
  }

  async routeToOutput(outputId: string, message: Message, callback?: MessageCallback): Promise<unknown> {
    const output = this.outputs.get(outputId);
    if (!output) {
      const error = new Error('Output ' + outputId + ' not registered');
      this.log.error('Route to output failed', error, { outputId });
      throw error;
    }
    
    if (callback) {
      const callbackId = 'cb-' + Date.now() + '-' + this.nextCallbackId++;
      this.pendingCallbacks.set(callbackId, callback);
      (message as Record<string, unknown>)._callbackId = callbackId;
    }
    
    try {
      return await output.handler(message, callback);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('Output handler error', error, { outputId });
      throw err;
    }
  }

  async sendToModule(moduleId: string, message: Message, callback?: MessageCallback): Promise<unknown> {
    const output = this.outputs.get(moduleId);
    if (output) {
      return this.routeToOutput(moduleId, message, callback);
    }
    
    const input = this.inputs.get(moduleId);
    if (input) {
      try {
        const result = await input.handler(message);
        if (callback) callback(result);
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('Input handler error', error, { moduleId });
        throw error;
      }
    }
    
    const error = new Error('Module ' + moduleId + ' not registered as input or output');
    this.log.error('Send to module failed', error, { moduleId });
    throw error;
  }

  processQueue(): number {
    let processed = 0;
    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const item of queue) {
      try {
        this.send(item.message, item.callback);
        processed++;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.log.error('Failed to process queued message', error);
        this.messageQueue.push(item);
      }
    }

    if (processed > 0) {
      this.log.info('Processed queued messages', { processed, remaining: this.messageQueue.length });
    }
    return processed;
  }

  getQueueLength(): number {
    return this.messageQueue.length;
  }

  executeCallback(callbackId: string, result: unknown): boolean {
    const callback = this.pendingCallbacks.get(callbackId);
    if (callback) {
      callback(result);
      this.pendingCallbacks.delete(callbackId);
      return true;
    }
    return false;
  }

  reset(): void {
    this.routes = [];
    this.inputs.clear();
    this.outputs.clear();
    this.pendingCallbacks.clear();
    this.messageQueue = [];
    this.log.info('Reset complete');
  }

  getPausedModules() {
    return errorHandler.getPausedModules();
  }

  async resumeModule(moduleId: string): Promise<boolean> {
    return errorHandler.resumeModule(moduleId);
  }
}

export const messageHub = new MessageHub();
