import type { Task, Agent } from '../core/types.js';

export interface SchedulingResult {
  taskId: string;
  agentId: string | null;
  reason: string;
}

export class Scheduler {
  private taskQueue: Task[] = [];

  schedule(tasks: Task[], agents: Agent[]): SchedulingResult[] {
    const results: SchedulingResult[] = [];
    const readyTasks = this.getReadyTasks(tasks);

    for (const task of readyTasks) {
      const agent = this.findAgent(task, agents);

      if (agent) {
        results.push({
          taskId: task.id,
          agentId: agent.id,
          reason: `Assigned to ${agent.role} agent`
        });
      } else {
        results.push({
          taskId: task.id,
          agentId: null,
          reason: 'No suitable agent available'
        });
      }
    }

    return results;
  }

  private getReadyTasks(tasks: Task[]): Task[] {
    const completedIds = new Set(
      tasks.filter(t => t.status === 'closed').map(t => t.id)
    );

    const ready = tasks.filter(task => {
      if (task.status !== 'open' && task.status !== 'in_progress') return false;
      return task.dependencies.every(depId => completedIds.has(depId));
    });

    return this.sortByPriority(ready);
  }

  private sortByPriority(tasks: Task[]): Task[] {
    return tasks.sort((a, b) => {
      if (a.isMainPath !== b.isMainPath) {
        return a.isMainPath ? 1 : -1;
      }
      return b.priority - a.priority;
    });
  }

  private findAgent(task: Task, agents: Agent[]): Agent | undefined {
    const idleAgents = agents.filter(a => a.status === 'idle');

    const rolePriority: Record<string, string[]> = {
      'executor': ['executor', 'orchestrator'],
      'architect': ['architect', 'orchestrator'],
      'tester': ['tester', 'executor'],
      'docwriter': ['docwriter', 'executor'],
      'reviewer': ['reviewer', 'orchestrator'],
      'orchestrator': ['orchestrator']
    };

    const taskRoles = this.inferTaskRole(task);
    const preferredRoles = taskRoles.flatMap(r => rolePriority[r] || []);
    const roleSet = new Set(preferredRoles);

    for (const role of roleSet) {
      const found = idleAgents.find(a => a.role === role);
      if (found) return found;
    }

    return undefined;
  }

  private inferTaskRole(task: Task): string[] {
    const title = task.title.toLowerCase();

    if (title.includes('review')) return ['reviewer'];
    if (title.includes('test')) return ['tester'];
    if (title.includes('design') || title.includes('architect')) return ['architect'];
    if (title.includes('doc')) return ['docwriter'];

    return ['executor'];
  }
}
