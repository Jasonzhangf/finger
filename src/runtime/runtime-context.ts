/**
 * RuntimeContext - 统一的运行时依赖注入入口
 * 
 * 所有工具通过 context.getDeps() 获取 AgentRuntimeDeps，
 * 不再需要每个工具单独传递 getAgentRuntimeDeps 参数。
 */

import type { AgentRuntimeDeps } from '../server/modules/agent-runtime/types.js';

let runtimeContextInstance: RuntimeContext | null = null;

export class RuntimeContext {
  private getAgentRuntimeDeps: () => AgentRuntimeDeps;

  constructor(getAgentRuntimeDeps: () => AgentRuntimeDeps) {
    this.getAgentRuntimeDeps = getAgentRuntimeDeps;
  }

  /**
   * 获取 AgentRuntimeDeps（所有工具统一入口）
   */
  getDeps(): AgentRuntimeDeps {
    return this.getAgentRuntimeDeps();
  }

  /**
   * 全局单例初始化（server 启动时调用一次）
   */
  static initialize(getAgentRuntimeDeps: () => AgentRuntimeDeps): void {
    if (runtimeContextInstance) {
      throw new Error('RuntimeContext already initialized');
    }
    runtimeContextInstance = new RuntimeContext(getAgentRuntimeDeps);
  }

  /**
   * 获取全局实例
   */
  static getInstance(): RuntimeContext {
    if (!runtimeContextInstance) {
      throw new Error('RuntimeContext not initialized. Call RuntimeContext.initialize() first.');
    }
    return runtimeContextInstance;
  }

  /**
   * 清理（测试用）
   */
  static reset(): void {
    runtimeContextInstance = null;
  }
}

/**
 * 全局快捷方法（工具直接调用）
 */
export function getRuntimeDeps(): AgentRuntimeDeps {
  return RuntimeContext.getInstance().getDeps();
}
