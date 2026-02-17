/**
 * ToolRegistry - 最小策略工具注册表
 * 支持 allow/deny 策略
 */

export type ToolPolicy = 'allow' | 'deny';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  policy: ToolPolicy;
  handler: (input: unknown) => Promise<unknown>;
}

export interface ToolInfo {
  name: string;
  description: string;
  policy: ToolPolicy;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /**
   * 注册工具
   */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool ${tool.name} already registered, overwriting`);
    }
    this.tools.set(tool.name, { ...tool });
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 取消注册工具
   */
  unregister(toolName: string): boolean {
    return this.tools.delete(toolName);
  }

  /**
   * 获取工具定义
   */
  get(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  /**
   * 获取工具策略
   */
  getPolicy(toolName: string): ToolPolicy {
    const tool = this.tools.get(toolName);
    if (!tool) return 'deny'; // 未注册工具默认拒绝
    return tool.policy;
  }

  /**
   * 设置工具策略
   */
  setPolicy(toolName: string, policy: ToolPolicy): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    tool.policy = policy;
    return true;
  }

  /**
   * 执行工具
   */
  async execute(toolName: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    if (tool.policy === 'deny') {
      throw new Error(`Tool ${toolName} is not allowed (policy: deny)`);
    }

    return tool.handler(input);
  }

  /**
   * 检查工具是否可用
   */
  isAvailable(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    return tool !== undefined && tool.policy === 'allow';
  }

  /**
   * 列出所有工具
   */
  list(): ToolInfo[] {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      policy: t.policy,
    }));
  }

  /**
   * 列出允许的工具
   */
  listAllowed(): ToolInfo[] {
    return this.list().filter(t => t.policy === 'allow');
  }

  /**
   * 列出拒绝的工具
   */
  listDenied(): ToolInfo[] {
    return this.list().filter(t => t.policy === 'deny');
  }

  /**
   * 允许所有工具
   */
  allowAll(): void {
    for (const tool of this.tools.values()) {
      tool.policy = 'allow';
    }
  }

  /**
   * 拒绝所有工具
   */
  denyAll(): void {
    for (const tool of this.tools.values()) {
      tool.policy = 'deny';
    }
  }

  /**
   * 清空注册表
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * 获取工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}

// 全局单例
export const globalToolRegistry = new ToolRegistry();
