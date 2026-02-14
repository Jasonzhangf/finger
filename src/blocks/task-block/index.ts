import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
  import type { Task } from '../../core/types.js';

export class TaskBlock extends BaseBlock {
  readonly type = 'task';
  readonly capabilities: BlockCapabilities = {
    functions: ['create', 'get', 'update', 'delete', 'list', 'ready'],
    cli: [
      { name: 'create', description: 'Create a new task', args: [] },
      { name: 'list', description: 'List all tasks', args: [] },
      { name: 'show', description: 'Show task details', args: [] },
      { name: 'status', description: 'Update task status', args: [] }
    ],
    stateSchema: {
      tasks: { type: 'object', readonly: false, description: 'All tasks' },
      count: { type: 'number', readonly: true, description: 'Total task count' }
    },
    events: ['task:created', 'task:updated', 'task:status_changed', 'task:deleted']
  };

  private tasks: Map<string, Task> = new Map();

  constructor(id: string) {
    super(id, 'task');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'create':
        return this.create(args as unknown as Partial<Task>);
      case 'get':
        return this.get(args.id as string);
      case 'update':
        return this.update(args.id as string, args as Partial<Task>);
      case 'delete':
        return this.delete(args.id as string);
      case 'list':
        return this.list(args as Record<string, unknown>);
      case 'ready':
        return this.getReadyTasks();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private create(data: Partial<Task>): Task {
    const id = data.id || `task-${Date.now()}`;
    const task: Task = {
      id,
      title: data.title || '',
      description: data.description || '',
      priority: data.priority ?? 1,
      status: data.status || 'open',
      isMainPath: data.isMainPath ?? false,
      dependencies: data.dependencies || [],
      assignedAgent: data.assignedAgent,
      createdAt: new Date(),
      updatedAt: new Date(),
      retryCount: 0,
      artifacts: []
    };

    this.tasks.set(id, task);
    this.updateState({
      data: { count: this.tasks.size }
    });
    return task;
  }

  private get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  private update(id: string, data: Partial<Task>): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);

    const oldStatus = task.status;
    Object.assign(task, data, { updatedAt: new Date() });
    this.tasks.set(id, task);

    if (data.status && data.status !== oldStatus) {
      this.updateState({ data: { lastStatusChange: { id, from: oldStatus, to: data.status } } });
    }

    return task;
  }

  private delete(id: string): boolean {
    const result = this.tasks.delete(id);
    this.updateState({ data: { count: this.tasks.size } });
    return result;
  }

  private list(filter: Record<string, unknown>): Task[] {
    let tasks = Array.from(this.tasks.values());
    if (filter.status) {
      tasks = tasks.filter(t => t.status === filter.status);
    }
    if (filter.isMainPath !== undefined) {
      tasks = tasks.filter(t => t.isMainPath === filter.isMainPath);
    }
    return tasks.sort((a, b) => b.priority - a.priority);
  }

  private getReadyTasks(): Task[] {
    const ready: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === 'open' || task.status === 'in_progress') {
        const depsComplete = task.dependencies.every(depId => {
          const dep = this.tasks.get(depId);
          return dep && dep.status === 'closed';
        });
        if (depsComplete) {
          ready.push(task);
        }
      }
    }
    return ready.sort((a, b) => {
      if (a.isMainPath !== b.isMainPath) return a.isMainPath ? 1 : -1;
      return b.priority - a.priority;
    });
  }
}
