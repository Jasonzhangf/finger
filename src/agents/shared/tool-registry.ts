import { ToolAssignment } from '../protocol/schema.js';

export interface Tool {
  name: string;
  description: string;
  params: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolPermission {
  toolName: string;
  granted: boolean;
  constraints?: Record<string, unknown>;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private permissions: Map<string, Map<string, ToolPermission>> = new Map();

  /**
   * 注册工具
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * 获取工具
   */
  get(toolName: string): Tool | undefined {
    return this.tools.get(toolName);
  }

  /**
   * 列出所有可用工具
   */
  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * 编排者赋予工具给执行者
   */
  grant(agentId: string, assignment: ToolAssignment): boolean {
    if (!this.tools.has(assignment.toolName)) {
      return false;
    }

    if (!this.permissions.has(agentId)) {
      this.permissions.set(agentId, new Map());
    }

    const agentPerms = this.permissions.get(agentId)!;
    agentPerms.set(assignment.toolName, {
      toolName: assignment.toolName,
      granted: assignment.action === 'grant',
      constraints: assignment.constraints,
    });

    return true;
  }

  /**
   * 检查执行者是否有权限使用工具
   */
  canUse(agentId: string, toolName: string): boolean {
    const agentPerms = this.permissions.get(agentId);
    if (!agentPerms) return false;

    const perm = agentPerms.get(toolName);
    return perm?.granted === true;
  }

  /**
   * 获取执行者的工具约束
   */
  getConstraints(agentId: string, toolName: string): Record<string, unknown> | undefined {
    const agentPerms = this.permissions.get(agentId);
    if (!agentPerms) return undefined;

    const perm = agentPerms.get(toolName);
    return perm?.constraints;
  }

  /**
   * 列出执行者被授予的所有工具
   */
  listGranted(agentId: string): ToolPermission[] {
    const agentPerms = this.permissions.get(agentId);
    if (!agentPerms) return [];

    return Array.from(agentPerms.values()).filter(p => p.granted);
  }

  /**
   * 收回执行者的工具权限
   */
  revoke(agentId: string, toolName: string): boolean {
    const agentPerms = this.permissions.get(agentId);
    if (!agentPerms) return false;

    const perm = agentPerms.get(toolName);
    if (!perm) return false;

    perm.granted = false;
    return true;
  }

  /**
   * 执行工具（带权限检查）
   */
  async execute(
    agentId: string,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    if (!this.canUse(agentId, toolName)) {
      return { success: false, error: `Tool '${toolName}' not granted to agent '${agentId}'` };
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      return { success: false, error: `Tool '${toolName}' not found` };
    }

    try {
      const result = await tool.handler(params);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Tool execution failed',
      };
    }
  }
}
