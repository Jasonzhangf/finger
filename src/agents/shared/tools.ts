import { Tool } from './tool-registry.js';

/**
 * 标准工具集定义
 * 所有 Agent 可用的工具在此注册
 */

export const FileReadTool: Tool = {
  name: 'file.read',
  description: '读取文件内容',
  params: {
    path: { type: 'string', required: true, description: '文件路径' },
    encoding: { type: 'string', required: false, default: 'utf-8' },
  },
  handler: async (params) => {
    const fs = await import('fs/promises');
    const content = await fs.readFile(params.path as string, {
      encoding: (params.encoding as BufferEncoding) || 'utf-8',
    });
    return { content, path: params.path };
  },
};

export const FileWriteTool: Tool = {
  name: 'file.write',
  description: '写入文件内容',
  params: {
    path: { type: 'string', required: true },
    content: { type: 'string', required: true },
    encoding: { type: 'string', required: false, default: 'utf-8' },
  },
  handler: async (params) => {
    const fs = await import('fs/promises');
    await fs.writeFile(params.path as string, params.content as string, {
      encoding: (params.encoding as BufferEncoding) || 'utf-8',
    });
    return { success: true, path: params.path, bytes: (params.content as string).length };
  },
};

export const FileListTool: Tool = {
  name: 'file.list',
  description: '列出目录内容',
  params: {
    path: { type: 'string', required: true },
    recursive: { type: 'boolean', required: false, default: false },
  },
  handler: async (params) => {
    const fs = await import('fs/promises');
    const entries = await fs.readdir(params.path as string, { withFileTypes: true });
    return {
      path: params.path,
      entries: entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
      })),
    };
  },
};

export const ShellExecTool: Tool = {
  name: 'shell.exec',
  description: '执行 shell 命令',
  params: {
    command: { type: 'string', required: true },
    cwd: { type: 'string', required: false },
    timeout: { type: 'number', required: false, default: 30000 },
  },
  handler: async (params) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    const { stdout, stderr } = await execAsync(params.command as string, {
      cwd: params.cwd as string | undefined,
      timeout: (params.timeout as number) || 30000,
    });
    return { stdout, stderr, command: params.command };
  },
};

export const BdQueryTool: Tool = {
  name: 'bd.query',
  description: '查询 bd 任务状态',
  params: {
    issueId: { type: 'string', required: false },
    status: { type: 'string', required: false },
    limit: { type: 'number', required: false, default: 10 },
  },
  handler: async (params) => {
    // 通过 CLI 调用 bd
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    let cmd = 'bd --no-db list --json';
    if (params.status) cmd += ` --status ${params.status}`;
    if (params.limit) cmd += ` --limit ${params.limit}`;
    
    const { stdout } = await execAsync(cmd);
    return { issues: JSON.parse(stdout || '[]') };
  },
};

export const BdUpdateTool: Tool = {
  name: 'bd.update',
  description: '更新 bd 任务状态',
  params: {
    issueId: { type: 'string', required: true },
    status: { type: 'string', required: true },
    notes: { type: 'string', required: false },
  },
  handler: async (params) => {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    let cmd = `bd --no-db update ${params.issueId} --status ${params.status}`;
    if (params.notes) cmd += ` --notes "${params.notes}"`;
    
    const { stdout } = await execAsync(cmd);
    return { success: true, issueId: params.issueId, output: stdout };
  },
};

/**
 * 获取所有标准工具
 */
export function getAllTools(): Tool[] {
  return [
    FileReadTool,
    FileWriteTool,
    FileListTool,
    ShellExecTool,
    BdQueryTool,
    BdUpdateTool,
  ];
}

/**
 * 按角色获取默认工具集
 */
export function getToolsForRole(role: string): Tool[] {
  switch (role) {
    case 'executor':
      return [FileReadTool, FileWriteTool, FileListTool, ShellExecTool];
    case 'reviewer':
      return [FileReadTool, BdQueryTool];
    case 'tester':
      return [FileReadTool, ShellExecTool, BdQueryTool];
    case 'architect':
      return [FileReadTool, FileListTool, BdQueryTool];
    default:
      return [FileReadTool];
  }
}

/**
 * 工具能力声明接口
 * Agent 通过此接口暴露自己支持的工具
 */
export interface ToolCapability {
  name: string;
  description: string;
  params: Record<string, unknown>;
}

/**
 * Agent 能力声明
 */
export interface AgentCapability {
  agentId: string;
  role: string;
  tools: ToolCapability[];
  maxConcurrentTasks: number;
  supportedModes: string[];
}

/**
 * 创建 Agent 能力声明
 */
export function createCapability(
  agentId: string,
  role: string,
  tools: Tool[]
): AgentCapability {
  return {
    agentId,
    role,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      params: t.params,
    })),
    maxConcurrentTasks: 1,
    supportedModes: ['execute', 'review'],
  };
}
