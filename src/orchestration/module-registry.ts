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

  constructor(hub: MessageHub) {
    this.hub = hub;
  }

  /**
   * 注册模块
   */
  async register(module: OrchestrationModule): Promise<void> {
    if (this.modules.has(module.id)) {
      throw new Error(`Module with id ${module.id} already registered`);
    }

    this.modules.set(module.id, module);

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

    console.log(`[Registry] Module registered: ${module.id} (${module.type})`);
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
        throw new Error(`No valid module export found in ${absPath}`);
      }
    } catch (err) {
      console.error(`[Registry] Failed to load module from ${absPath}:`, err);
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
