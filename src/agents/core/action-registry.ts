/**
 * Action Registry - 通用行动注册表
 * 
 * 职责：管理 Agent 可执行的所有 Action
 * 特点：支持动态注册、参数验证、权限控制
 */

export interface ActionDefinition {
  name: string;
  description: string;
  paramsSchema: Record<string, ParamSchema>;
  handler: ActionHandler;
  requiresApproval?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  category?: string;
}

export interface ParamSchema {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
}

export interface ActionContext {
  round: number;
  iteration: number;
  cwd?: string;
  state: unknown;
  agentId: string;
  agentRole: string;
}

export interface ActionResult {
  success: boolean;
  observation: string;
  data?: unknown;
  error?: string;
  shouldStop?: boolean;
  stopReason?: 'complete' | 'fail' | 'escalate';
}

export type ActionHandler = (params: Record<string, unknown>, context: ActionContext) => Promise<ActionResult>;

export class ActionRegistry {
  private actions: Map<string, ActionDefinition> = new Map();

  register(action: ActionDefinition): void {
    this.actions.set(action.name, action);
  }

  get(name: string): ActionDefinition | undefined {
    return this.actions.get(name);
  }

  list(): ActionDefinition[] {
    return Array.from(this.actions.values());
  }

  listByRole(role: string): ActionDefinition[] {
    return this.list().filter(a => !a.category || a.category === 'common' || a.category === role);
  }

  validateParams(name: string, params: Record<string, unknown>): { valid: boolean; error?: string } {
    const action = this.actions.get(name);
    if (!action) {
      return { valid: false, error: `Unknown action: ${name}` };
    }

    for (const [key, schema] of Object.entries(action.paramsSchema)) {
      if (schema.required && !(key in params)) {
        return { valid: false, error: `Missing required parameter: ${key}` };
      }

      if (key in params) {
        const value = params[key];
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== schema.type) {
          return { valid: false, error: `Parameter ${key} must be ${schema.type}, got ${actualType}` };
        }
      }
    }

    return { valid: true };
  }

  async execute(name: string, params: Record<string, unknown>, context: ActionContext): Promise<ActionResult> {
    const action = this.actions.get(name);
    if (!action) {
      return {
        success: false,
        observation: `Unknown action: ${name}`,
        error: `Action ${name} not found in registry`,
      };
    }

    const validation = this.validateParams(name, params);
    if (!validation.valid) {
      return {
        success: false,
        observation: validation.error || 'Invalid parameters',
        error: validation.error,
      };
    }

    try {
      return await action.handler(params, context);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        observation: `Execution error: ${errorMsg}`,
        error: errorMsg,
      };
    }
  }

  getRiskLevel(name: string): 'low' | 'medium' | 'high' {
    const action = this.actions.get(name);
    return action?.riskLevel || 'medium';
  }
}

/**
 * 创建基础执行者 Action 集合
 */
export function createExecutorActions(cwd?: string): ActionDefinition[] {
  return [
    {
      name: 'WRITE_FILE',
      description: '创建或覆盖文件',
      paramsSchema: {
        path: { type: 'string', required: true, description: '文件路径（相对于工作目录）' },
        content: { type: 'string', required: true, description: '文件内容' },
      },
      riskLevel: 'medium',
      category: 'file',
      handler: async (params) => {
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.resolve(cwd || process.cwd(), params.path as string);
        
        try {
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, params.content as string, 'utf-8');
          return {
            success: true,
            observation: `文件已创建: ${params.path}`,
            data: { path: params.path },
          };
        } catch (e) {
          return {
            success: false,
            observation: `文件创建失败: ${e}`,
            error: String(e),
          };
        }
      },
    },
    {
      name: 'SHELL_EXEC',
      description: '执行 shell 命令',
      paramsSchema: {
        command: { type: 'string', required: true, description: '要执行的 shell 命令' },
        timeout: { type: 'number', required: false, description: '超时时间（毫秒）', default: 30000 },
      },
      riskLevel: 'high',
      category: 'system',
      handler: async (params) => {
        const { exec } = await import('child_process');
        const command = params.command as string;
        const timeout = (params.timeout as number) || 30000;
        
        return new Promise((resolve) => {
          exec(command, { cwd, timeout }, (error, stdout, stderr) => {
            if (error) {
              resolve({
                success: false,
                observation: `命令执行失败: ${error.message}\n${stderr}`,
                error: error.message,
              });
            } else {
              resolve({
                success: true,
                observation: stdout || stderr || '命令执行成功（无输出）',
                data: { stdout, stderr },
              });
            }
          });
        });
      },
    },
    {
      name: 'FETCH_URL',
      description: '获取网页内容',
      paramsSchema: {
        url: { type: 'string', required: true, description: '网页 URL' },
        saveTo: { type: 'string', required: false, description: '保存路径（可选）' },
      },
      riskLevel: 'low',
      category: 'web',
      handler: async (params) => {
        const https = await import('https');
        const http = await import('http');
        const url = params.url as string;
        const client = url.startsWith('https') ? https : http;
        
        return new Promise((resolve) => {
          let data = '';
          client.get(url, { timeout: 15000 }, (res) => {
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              resolve({
                success: true,
                observation: `获取成功，长度: ${data.length}`,
                data: { content: data, statusCode: res.statusCode },
              });
            });
          }).on('error', (e) => {
            resolve({
              success: false,
              observation: `获取失败: ${e.message}`,
              error: e.message,
            });
          });
        });
      },
    },
    {
      name: 'COMPLETE',
      description: '任务完成',
      paramsSchema: {
        output: { type: 'string', required: true, description: '完成说明或结果摘要' },
      },
      riskLevel: 'low',
      category: 'control',
      handler: async (params) => ({
        success: true,
        observation: `任务完成: ${params.output}`,
        data: { output: params.output },
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '任务失败',
      paramsSchema: {
        reason: { type: 'string', required: true, description: '失败原因' },
      },
      riskLevel: 'low',
      category: 'control',
      handler: async (params) => ({
        success: false,
        observation: `任务失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}

/**
 * 创建编排者 Action 集合
 */
export function createOrchestratorActions(): ActionDefinition[] {
  return [
    {
      name: 'PLAN',
      description: '拆解任务为子任务列表',
      paramsSchema: {
        tasks: { type: 'array', required: true, description: '子任务列表' },
      },
      riskLevel: 'low',
      category: 'orchestrator',
      handler: async (params) => ({
        success: true,
        observation: `已拆解 ${(params.tasks as unknown[]).length} 个子任务`,
        data: { tasks: params.tasks },
      }),
    },
    {
      name: 'DISPATCH',
      description: '派发任务给执行者',
      paramsSchema: {
        taskId: { type: 'string', required: true, description: '任务 ID' },
        assignee: { type: 'string', required: true, description: '执行者 ID' },
      },
      riskLevel: 'low',
      category: 'orchestrator',
      handler: async (params) => ({
        success: true,
        observation: `任务 ${params.taskId} 已派发给 ${params.assignee}`,
        data: { taskId: params.taskId, assignee: params.assignee },
      }),
    },
    {
      name: 'COMPLETE',
      description: '编排完成',
      paramsSchema: {
        summary: { type: 'string', required: true, description: '完成摘要' },
      },
      riskLevel: 'low',
      category: 'control',
      handler: async (params) => ({
        success: true,
        observation: `编排完成: ${params.summary}`,
        data: { summary: params.summary },
        shouldStop: true,
        stopReason: 'complete',
      }),
    },
    {
      name: 'FAIL',
      description: '编排失败',
      paramsSchema: {
        reason: { type: 'string', required: true, description: '失败原因' },
      },
      riskLevel: 'low',
      category: 'control',
      handler: async (params) => ({
        success: false,
        observation: `编排失败: ${params.reason}`,
        error: params.reason as string,
        shouldStop: true,
        stopReason: 'fail',
      }),
    },
  ];
}
