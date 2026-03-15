/**
 * 模块注册表 - 支持动态注册输入、输出和Agent模块
 */

import path from 'path';
import { pathToFileURL } from 'url';
import { MessageHub } from './message-hub.js';

export type ModuleType = 'input' | 'output' | 'agent';

/**
 * 模块接口定义
 */
export interface OrchestrationModule {
  /** 模块唯一标识 */
  id: string;
  /** 模块类型 */
  type: ModuleType;
  /** 模块名称 */
  name: string;
  /** 模块版本 */
  version: string;
  /** 模块初始化函数（可选） */
  initialize?: (hub: MessageHub) => Promise<void>;
  /** 模块销毁函数（可选） */
  destroy?: () => Promise<void>;
  /** 模块元数据 */
  metadata?: Record<string, unknown>;
  /** 模块健康检查函数（可选） */
  healthCheck?: () => Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; message?: string }>;
}

/**
 * 输入模块接口
 */
export interface InputModule extends OrchestrationModule {
  type: 'input';
  /** 处理输入消息的函数 */
  handle: (message: any) => Promise<any>;
  /** 默认路由目标 */
  defaultRoutes?: string[];
}

/**
 * 输出模块接口
 */
export interface OutputModule extends OrchestrationModule {
  type: 'output';
  /** 处理输出消息的函数 */
  handle: (message: any, callback?: (result: any) => void) => Promise<any>;
}

/**
 * Agent模块接口
 */
export interface AgentModule extends OrchestrationModule {
  type: 'agent';
  /** Agent支持的指令列表 */
  capabilities: string[];
  /** 执行指令 */
  execute: (command: string, params: any) => Promise<any>;
  /** 获取Agent状态 */
  getStatus?: () => Promise<any>;
}

/**
 * 模块注册表 - 管理所有动态模块
 */
export class ModuleRegistry {
  private modules: Map<string, OrchestrationModule> = new Map();
  private hub: MessageHub;
  private registrationErrors: Map<string, Error> = new Map();

  constructor(hub: MessageHub) {
    this.hub = hub;
  }

  /**
   * 注册模块
   */
  async register(module: OrchestrationModule): Promise<void> {
    const existing = this.modules.get(module.id);
    if (existing) {
      if (existing.version !== module.version) {
        const error = new Error(
          `Module ${module.id} version conflict: existing=${existing.version}, new=${module.version}`
        );
        this.registrationErrors.set(module.id, error);
        throw error;
      }
      throw new Error(`Module with id ${module.id} already registered (version ${module.version})`);
    }

    this.modules.set(module.id, module);

    // Clear any previous registration error
    this.registrationErrors.delete(module.id);

    // 根据类型进行特殊注册
    if (module.type === 'input') {
      const inputModule = module as InputModule;
      this.hub.registerInput(
        module.id,
        async (msg) => inputModule.handle(msg),
        inputModule.defaultRoutes || []
      );
    } else if (module.type === 'output') {
      const outputModule = module as OutputModule;
      this.hub.registerOutput(
        module.id,
        async (msg, cb) => outputModule.handle(msg, cb)
      );
    }

    // 调用模块初始化函数
    if (module.initialize) {
      await module.initialize(this.hub);
    }

    console.log(`[Registry] Module registered: ${module.id} (${module.type}) v${module.version}`);
  }

  /**
   * 注销模块
   */
  async unregister(id: string): Promise<boolean> {
    const module = this.modules.get(id);
    if (!module) return false;

    if (module.destroy) {
      await module.destroy();
    }

    if (module.type === 'input') {
      this.hub.unregisterInput(id);
    } else if (module.type === 'output') {
      this.hub.unregisterOutput(id);
    }

    this.modules.delete(id);
    this.registrationErrors.delete(id);
    console.log(`[Registry] Module unregistered: ${id}`);
    return true;
  }

  /**
   * 获取模块
   */
  getModule(id: string): OrchestrationModule | undefined {
    return this.modules.get(id);
  }

  /**
   * 获取所有模块
   */
  getAllModules(): OrchestrationModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * 按类型获取模块
   */
  getModulesByType(type: ModuleType): OrchestrationModule[] {
    return this.getAllModules().filter(m => m.type === type);
  }

  /**
   * 检查模块健康状态
   */
  async checkHealth(id: string): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
    message?: string;
  } | null> {
    const module = this.modules.get(id);
    if (!module) return null;

    if (module.healthCheck) {
      try {
        const result = await module.healthCheck();
        return {
          ...result,
          version: module.version,
        };
      } catch (err) {
        return {
          status: 'unhealthy',
          version: module.version,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // Default healthy if no health check implemented
    return {
      status: 'healthy',
      version: module.version,
    };
  }

  /**
   * 获取所有模块的健康状态
   */
  async getAllHealthStatus(): Promise<Map<string, {
    status: 'healthy' | 'degraded' | 'unhealthy';
    version: string;
    message?: string;
  }>> {
    const results = new Map();
    for (const id of this.modules.keys()) {
      const status = await this.checkHealth(id);
      if (status) results.set(id, status);
    }
    return results;
  }

  /**
   * 获取注册错误列表
   */
  getRegistrationErrors(): Map<string, Error> {
    return new Map(this.registrationErrors);
  }

  /**
   * 获取模块注册失败原因
   */
  getRegistrationError(id: string): Error | undefined {
    return this.registrationErrors.get(id);
  }

  /**
   * 动态加载模块（从文件）
   */
  async loadFromFile(filePath: string): Promise<void> {
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const moduleUrl = pathToFileURL(absPath).href;

    try {
      const moduleExports = await import(moduleUrl);
      const moduleDef = moduleExports.default || moduleExports;

      if (Array.isArray(moduleDef)) {
        for (const mod of moduleDef) {
          await this.register(mod);
        }
      } else if (moduleDef && moduleDef.id && moduleDef.type) {
        await this.register(moduleDef);
      } else {
        const error = new Error(
          `[MODULE_LOAD_ERROR] No valid module export found in ${absPath}. ` +
          `Ensure module exports a default object with 'id', 'type', 'name', 'version', 'entry' fields.`
        );
        console.error(`[Registry] ${error.message}`);
        throw error;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const error = new Error(
        `[MODULE_LOAD_ERROR] Failed to load module from ${absPath}: ${errorMsg}`
      );
      console.error(`[Registry] ${error.message}`);
      throw err;
    }
  }

  /**
   * 创建动态路由规则
   */
  createRoute(
    pattern: string | RegExp | ((msg: any) => boolean),
    targetOutputId: string,
    options: { blocking?: boolean; priority?: number; description?: string } = {}
  ): string {
    return this.hub.addRoute({
      pattern,
      handler: async (msg) => {
        return this.hub.routeToOutput(targetOutputId, msg);
      },
      blocking: options.blocking ?? false,
      priority: options.priority ?? 0,
      description: options.description
    });
  }
}
