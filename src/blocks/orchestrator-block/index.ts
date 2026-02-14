import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

export class OrchestratorBlock extends BaseBlock {
  readonly type = 'orchestrator';
  readonly capabilities: BlockCapabilities = {
    functions: ['start', 'pause', 'resume', 'status', 'decompose', 'schedule'],
    cli: [
      { name: 'status', description: 'Orchestrator status', args: [] },
      { name: 'start', description: 'Start orchestration', args: [] },
      { name: 'pause', description: 'Pause orchestration', args: [] }
    ],
    stateSchema: {
      running: { type: 'boolean', readonly: true, description: 'Is orchestrator running' },
      activeProjects: { type: 'number', readonly: true, description: 'Active project count' }
    }
  };

  private running = false;
  private activeProjects: string[] = [];

  constructor(id: string) {
    super(id, 'orchestrator');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'start':
        return this.doStart();
      case 'pause':
        return this.doPause();
      case 'resume':
        return this.doResume();
      case 'status':
        return this.doGetStatus();
      case 'decompose':
        return this.doDecompose(args.projectId as string, args.task as string);
      case 'schedule':
        return this.doSchedule(args.projectId as string);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private doStart(): { started: boolean } {
    this.running = true;
    this.syncState();
    return { started: true };
  }

  private doPause(): { paused: boolean } {
    this.running = false;
    this.syncState();
    return { paused: true };
  }

  private doResume(): { resumed: boolean } {
    this.running = true;
    this.syncState();
    return { resumed: true };
  }

  private doGetStatus(): { running: boolean; activeProjects: string[] } {
    return {
      running: this.running,
      activeProjects: this.activeProjects
    };
  }

  private doDecompose(projectId: string, _task: string): { projectId: string; decomposed: boolean } {
    if (!this.activeProjects.includes(projectId)) {
      this.activeProjects.push(projectId);
    }
    this.syncState();
    return { projectId, decomposed: true };
  }

  private doSchedule(_projectId: string): { scheduled: boolean } {
    return { scheduled: this.running };
  }

  private syncState(): void {
    this.updateState({
      data: {
        running: this.running,
        activeProjects: this.activeProjects.length
      }
    });
  }
}
