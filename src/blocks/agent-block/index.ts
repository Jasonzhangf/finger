import { spawn, type ChildProcess } from 'child_process';
import { lifecycleManager } from '../../agents/core/agent-lifecycle.js';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import type { Agent, AgentRole, SpecialistType } from '../../core/types.js';

interface SpawnArgs {
  role: AgentRole;
  sdk: 'iflow' | 'codex' | 'claude';
  specialistType?: SpecialistType;
  capabilities?: string[];
}

interface AssignArgs {
  agentId: string;
  taskId: string;
  prompt: string;
}

export class AgentBlock extends BaseBlock {
  readonly type = 'agent';
  readonly capabilities: BlockCapabilities = {
    functions: ['spawn', 'assign', 'status', 'kill', 'list', 'heartbeat'],
    cli: [
      { name: 'spawn', description: 'Spawn agent', args: [] },
      { name: 'list', description: 'List agents', args: [] },
      { name: 'status', description: 'Agent status', args: [] },
      { name: 'assign', description: 'Assign task', args: [] },
      { name: 'kill', description: 'Kill agent', args: [] }
    ],
    stateSchema: {
      agents: { type: 'object', readonly: true, description: 'All agents' },
      activeCount: { type: 'number', readonly: true, description: 'Active agent count' }
    },
    events: ['agent:spawned', 'agent:assigned', 'agent:completed', 'agent:error', 'agent:heartbeat']
  };

  private agents: Map<string, Agent> = new Map();
  private processes: Map<string, ChildProcess> = new Map();

  constructor(id: string) {
    super(id, 'agent');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'spawn':
        return this.spawn(args as unknown as SpawnArgs);
      case 'assign':
        return this.assign(args as unknown as AssignArgs);
      case 'status':
        return this.status(args.agentId as string);
      case 'kill':
        return this.kill(args.agentId as string);
      case 'list':
        return this.list();
      case 'heartbeat':
        return this.heartbeat(args.agentId as string);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private spawn(args: SpawnArgs): Agent {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const agent: Agent = {
      id,
      name: `${args.role}-${args.sdk}`,
      role: args.role,
      specialistType: args.specialistType,
      sdk: args.sdk,
      status: 'idle',
      capabilities: args.capabilities || [],
      currentTask: undefined,
      lastHeartbeat: new Date()
    };

    this.agents.set(id, agent);
    this.updateState({
      data: {
        activeCount: this.agents.size,
        lastSpawned: id
      }
    });

    return agent;
  }

  private async assign(args: AssignArgs): Promise<{ status: string; output?: string }> {
    const agent = this.agents.get(args.agentId);
    if (!agent) throw new Error(`Agent ${args.agentId} not found`);
    if (agent.status !== 'idle') throw new Error(`Agent ${args.agentId} is not idle`);

    agent.status = 'busy';
    agent.currentTask = args.taskId;
    agent.lastHeartbeat = new Date();

    const cmd = agent.sdk;
    const proc = spawn(cmd, ['-p', args.prompt], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    // Register with lifecycle manager
    lifecycleManager.registerProcess(`sdk-${args.agentId}`, proc, 'other', {
      type: 'agent-sdk',
      agentId: args.agentId,
      sdk: cmd
    });

    this.processes.set(args.agentId, proc);

    return new Promise((resolve) => {
      let output = '';
      let errors = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
        agent.lastHeartbeat = new Date();
        lifecycleManager.updateActivity(`sdk-${args.agentId}`);
      });

      proc.stderr?.on('data', (data) => {
        errors += data.toString();
      });

      proc.on('close', (code) => {
        agent.status = code === 0 ? 'idle' : 'error';
        agent.currentTask = undefined;
        agent.lastHeartbeat = new Date();
        this.processes.delete(args.agentId);
        
        // Update lifecycle manager activity
        lifecycleManager.updateActivity(`sdk-${args.agentId}`);

        resolve({
          status: code === 0 ? 'completed' : 'failed',
          output: code === 0 ? output : errors
        });
      });
    });
  }

  private status(agentId: string): Agent | undefined {
    return this.agents.get(agentId);
  }

  private kill(agentId: string): { killed: boolean } {
    const killed = lifecycleManager.killProcess(`sdk-${agentId}`, 'user-request');
    
    if (killed) {
      this.processes.delete(agentId);
    }

    const agent = this.agents.get(agentId);
    if (agent) {
      agent.status = 'error';
      agent.currentTask = undefined;
    }

    return { killed: true };
  }

  private list(): Agent[] {
    return Array.from(this.agents.values());
  }

  private heartbeat(agentId: string): { alive: boolean } {
    const agent = this.agents.get(agentId);
    if (!agent) return { alive: false };
    agent.lastHeartbeat = new Date();
    return { alive: true };
  }
}
