/**
 * bd CLI 工具封装 - 为 Agent 系统提供任务管理能力
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface BdTaskOptions {
  title: string;
  description?: string;
  type?: 'task' | 'epic' | 'bug' | 'review' | 'question';
  parent?: string;
  priority?: number;
  assignee?: string;
  labels?: string[];
  acceptance?: string[];
}

export interface BdTask {
  id: string;
  title: string;
  status: 'open' | 'in_progress' | 'blocked' | 'review' | 'closed';
  assignee?: string;
  parent?: string;
  labels: string[];
  priority: number;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface Deliverable {
  type: 'file' | 'result' | 'log' | 'doc' | 'summary' | 'stats';
  path?: string;
  content?: string;
  checksum?: string;
}

export interface EpicProgress {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  open: number;
}

/**
 * bd CLI 封装类
 */
export class BdTools {
  private cwd: string;

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd();
  }

  /**
   * 执行 bd 命令
   */
  private async run(args: string): Promise<string> {
    const cmd = `bd --no-db ${args}`;
    try {
      const { stdout } = await execAsync(cmd, { cwd: this.cwd });
      return stdout;
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      throw new Error(`bd command failed: ${error.stderr ?? error.message}`);
    }
  }

  /**
   * 创建任务/Epic
   */
  async createTask(options: BdTaskOptions): Promise<BdTask> {
    const args: string[] = ['create', `"${options.title}"`];
    
    args.push('-p', String(options.priority ?? 1));
    
    if (options.type) {
      args.push('--type', options.type);
    }
    
    if (options.parent) {
      args.push('--parent', options.parent);
    }
    
    if (options.assignee) {
      args.push('--assignee', options.assignee);
    }
    
    if (options.labels?.length) {
      args.push('--label', options.labels.join(','));
    }
    
    const output = await this.run(args.join(' '));
    
    // 解析输出获取 task id
    const idMatch = output.match(/(finger-\d+(?:\.\d+)?)/);
    if (!idMatch) {
      throw new Error(`Failed to parse task id from: ${output}`);
    }
    
    return {
      id: idMatch[1],
      title: options.title,
      status: 'open',
      parent: options.parent,
      assignee: options.assignee,
      labels: options.labels ?? [],
      priority: options.priority ?? 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 更新任务状态
   */
  async updateStatus(taskId: string, status: BdTask['status']): Promise<void> {
    await this.run(`update ${taskId} --status ${status}`);
  }

  /**
   * 分配任务给执行者
   */
  async assignTask(taskId: string, assignee: string): Promise<void> {
    await this.run(`update ${taskId} --assignee ${assignee}`);
  }

  /**
   * 添加评论/进度记录
   */
  async addComment(taskId: string, content: string): Promise<void> {
    // bd 使用 notes 字段存储评论
    await this.run(`update ${taskId} --append-notes "${content.replace(/"/g, '\\"')}"`);
  }

  /**
   * 关闭任务并记录交付物
   */
  async closeTask(
    taskId: string,
    reason: string,
    deliverables?: Deliverable[]
  ): Promise<void> {
    let note = reason;
    
    if (deliverables?.length) {
      note += '\n\n交付物:\n';
      for (const d of deliverables) {
        if (d.type === 'file' && d.path) {
          note += `- 文件: ${d.path}${d.checksum ? ` (${d.checksum})` : ''}\n`;
        } else if (d.content) {
          note += `- ${d.type}: ${d.content.slice(0, 200)}...\n`;
        }
      }
    }
    
    await this.run(`close ${taskId} --reason "${note.replace(/"/g, '\\"')}"`);
  }

  /**
   * 创建依赖关系
   */
  async addDependency(blocked: string, blocker: string): Promise<void> {
    await this.run(`dep add ${blocked} ${blocker}`);
  }

  /**
   * 移除依赖关系
   */
  async removeDependency(blocked: string, blocker: string): Promise<void> {
    await this.run(`dep remove ${blocked} ${blocker}`);
  }

  /**
   * 获取���执行任务（无 blocker 的 open/in_progress）
   */
  async getReadyTasks(): Promise<BdTask[]> {
    const output = await this.run('ready --json');
    try {
      return JSON.parse(output);
    } catch {
      // 解析文本格式
      const lines = output.split('\n').filter(l => l.includes('finger-'));
      return lines.map(line => {
        const idMatch = line.match(/(finger-\d+(?:\.\d+)?)/);
        return {
          id: idMatch?.[1] ?? '',
          title: line,
          status: 'open' as const,
          labels: [],
          priority: 1,
          createdAt: '',
          updatedAt: '',
        };
      });
    }
  }

  /**
   * 获取任务详情
   */
  async getTask(taskId: string): Promise<BdTask | null> {
    try {
      const output = await this.run(`show ${taskId} --json`);
      const data = JSON.parse(output);
      return {
        id: data.id,
        title: data.title,
        status: data.status,
        assignee: data.assignee,
        parent: data.parent,
        labels: data.labels ?? [],
        priority: data.priority ?? 1,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        notes: data.notes,
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取特定执行者的任务
   */
  async getTasksByAssignee(assignee: string): Promise<BdTask[]> {
    const output = await this.run(`list --assignee ${assignee} --json`);
    try {
      return JSON.parse(output);
    } catch {
      return [];
    }
  }

  /**
   * 获取 Epic 的子任务
   */
  async getEpicTasks(epicId: string): Promise<BdTask[]> {
    const output = await this.run(`list --parent ${epicId} --json`);
    try {
      return JSON.parse(output);
    } catch {
      return [];
    }
  }

  /**
   * 获取 Epic 进度
   */
  async getEpicProgress(epicId: string): Promise<EpicProgress> {
    const tasks = await this.getEpicTasks(epicId);
    
    return {
      total: tasks.length,
      completed: tasks.filter(t => t.status === 'closed').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
      open: tasks.filter(t => t.status === 'open').length,
    };
  }

  /**
   * 标记任务为阻塞状态
   */
  async blockTask(taskId: string, reason: string): Promise<void> {
    await this.updateStatus(taskId, 'blocked');
    await this.addComment(taskId, `[阻塞] ${reason}`);
  }

  /**
   * 解除阻塞
   */
  async unblockTask(taskId: string): Promise<void> {
    await this.updateStatus(taskId, 'in_progress');
  }

  /**
   * 创建变更请求
   */
  async createChangeRequest(
    title: string,
    parentEpic: string,
    reason: string
  ): Promise<BdTask> {
    const task = await this.createTask({
      title,
      type: 'task',
      parent: parentEpic,
      priority: 0,
      labels: ['change'],
    });
    
    await this.addComment(task.id, `变更原因: ${reason}`);
    return task;
  }
}

/**
 * 创建 BdTools 实例
 */
export function createBdTools(cwd?: string): BdTools {
  return new BdTools(cwd);
}
