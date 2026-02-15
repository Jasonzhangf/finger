/**
 * 消息中枢 - 核心消息路由器
 * 负责所有组件之间的消息路由，支持阻塞/非阻塞模式
 */

export type Message = any;
export type MessageHandler = (message: Message) => Promise<any> | any;
export type MessageCallback = (result: any) => void;

/**
 * 路由规则条目
 */
export interface RouteEntry {
  id: string;
  /** 匹配模式：字符串类型名、正则表达式或自定义函数 */
  pattern: string | RegExp | ((message: Message) => boolean);
  /** 处理函数 */
  handler: MessageHandler;
  /** 是否阻塞（等待结果） */
  blocking: boolean;
  /** 优先级（数字越大优先级越高） */
  priority: number;
  /** 描述信息 */
  description?: string;
}

/**
 * 输入接口注册信息
 */
export interface InputRegistration {
  id: string;
  handler: MessageHandler;
  routes: string[]; // 目标输出ID列表
}

/**
 * 输出接口注册信息
 */
export interface OutputRegistration {
  id: string;
  handler: (message: Message, callback?: MessageCallback) => Promise<any>;
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

  /**
   * 注册输入接口
   */
  registerInput(id: string, handler: MessageHandler, routes: string[] = []): void {
    this.inputs.set(id, { id, handler, routes });
    console.log(`[Hub] Input registered: ${id}`);
  }

  /**
   * 注册输出接口
   */
  registerOutput(id: string, handler: (message: Message, callback?: MessageCallback) => Promise<any>): void {
    this.outputs.set(id, { id, handler });
    console.log(`[Hub] Output registered: ${id}`);
  }

  /**
   * 获取所有输入接口
   */
  getInputs(): InputRegistration[] {
    return Array.from(this.inputs.values());
  }

  /**
   * 获取所有输出接口
   */
  getOutputs(): OutputRegistration[] {
    return Array.from(this.outputs.values());
  }

  /**
   * 获取所有路由规则
   */
  getRoutes(): RouteEntry[] {
    return [...this.routes];
  }

  /**
   * 添加路由规则
   */
  addRoute(route: Omit<RouteEntry, 'id'> & { id?: string }): string {
    const id = route.id || `route-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.routes.push({ ...route, id } as RouteEntry);
    // 按优先级降序排序
    this.routes.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    console.log(`[Hub] Route added: ${id} (priority: ${route.priority})`);
    return id;
  }

  /**
   * 移除路由规则
   */
  removeRoute(id: string): boolean {
    const index = this.routes.findIndex(r => r.id === id);
    if (index >= 0) {
      this.routes.splice(index, 1);
      console.log(`[Hub] Route removed: ${id}`);
      return true;
    }
    return false;
  }

  /**
   * 发送消息（入口）
   */
  async send(message: Message, callback?: MessageCallback): Promise<any> {
    // 查找匹配的路由
    const matchingRoutes = this.routes.filter(r => {
      if (typeof r.pattern === 'function') {
        return r.pattern(message);
      }
      if (r.pattern instanceof RegExp) {
        return r.pattern.test(JSON.stringify(message));
      }
      // 字符串匹配：支持 message.type 或 message.route
      return message.type === r.pattern || message.route === r.pattern;
    });

    if (matchingRoutes.length === 0) {
      // 无匹配路由，入队等待
      this.messageQueue.push({ message, callback, timestamp: Date.now() });
      console.log(`[Hub] No matching route, message queued (queue length: ${this.messageQueue.length})`);
      return;
    }

    let lastResult: any;
    for (const route of matchingRoutes) {
      try {
        const result = await route.handler(message);
        lastResult = result;
        
        // 如果有回调，调用回调
        if (callback) {
          callback(result);
        }
        
        // 如果是阻塞路由，返回结果并停止继续处理
        if (route.blocking) {
          console.log(`[Hub] Blocking route ${route.id} handled, returning result`);
          return result;
        }
      } catch (err) {
        console.error(`[Hub] Route ${route.id} handler error:`, err);
        // 非阻塞路由出错不影响其他路由
        if (route.blocking) {
          throw err;
        }
      }
    }

    // 如果没有阻塞路由，返回最后一个结果
    return lastResult;
  }

  /**
   * 路由到指定输出接口
   */
  async routeToOutput(outputId: string, message: Message, callback?: MessageCallback): Promise<any> {
    const output = this.outputs.get(outputId);
    if (!output) {
      throw new Error(`Output ${outputId} not registered`);
    }
    
    // 如果需要回调，生成回调ID
    if (callback) {
      const callbackId = `cb-${Date.now()}-${this.nextCallbackId++}`;
      this.pendingCallbacks.set(callbackId, callback);
      message._callbackId = callbackId;
    }
    
    return await output.handler(message, callback);
  }

  /**
   * 向任意模块（输入或输出）发送消息
   */
  async sendToModule(moduleId: string, message: Message, callback?: MessageCallback): Promise<any> {
    // 先尝试作为输出
    const output = this.outputs.get(moduleId);
    if (output) {
      return this.routeToOutput(moduleId, message, callback);
    }
    // 再尝试作为输入
    const input = this.inputs.get(moduleId);
    if (input) {
      const result = await input.handler(message);
      if (callback) callback(result);
      return result;
    }
    throw new Error(`Module ${moduleId} not registered as input or output`);
  }

  /**
   * 处理队列中的消息
   */
  processQueue(): number {
    let processed = 0;
    const queue = [...this.messageQueue];
    this.messageQueue = [];

    for (const item of queue) {
      try {
        this.send(item.message, item.callback);
        processed++;
      } catch (err) {
        console.error('[Hub] Failed to process queued message:', err);
        // 重新入队
        this.messageQueue.push(item);
      }
    }

    if (processed > 0) {
      console.log(`[Hub] Processed ${processed} queued messages`);
    }
    return processed;
  }

  /**
   * 获取队列长度
   */
  getQueueLength(): number {
    return this.messageQueue.length;
  }

  /**
   * 执行回调（由输出接口调用）
   */
  executeCallback(callbackId: string, result: any): boolean {
    const callback = this.pendingCallbacks.get(callbackId);
    if (callback) {
      callback(result);
      this.pendingCallbacks.delete(callbackId);
      return true;
    }
    return false;
  }

  /**
   * 重置中枢（清空所有注册和队列）
   */
  reset(): void {
    this.routes = [];
    this.inputs.clear();
    this.outputs.clear();
    this.pendingCallbacks.clear();
    this.messageQueue = [];
    console.log('[Hub] Reset complete');
  }
}
