import { ChildProcess } from 'child_process';
import { lifecycleManager } from '../agents/core/agent-lifecycle.js';
import fs from 'fs';
import { FINGER_PATHS, ensureDir } from '../core/finger-paths.js';

export interface AgentInstanceConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  systemPrompt?: string;
  allowedTools?: string[];
  cwd?: string;
  port: number;
  autoStart?: boolean;
}

export interface AgentInstance {
  id: string;
  agentId: string;
  config: AgentInstanceConfig;
  process: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastError?: string;
  startedAt?: Date;
  pid?: number;
  currentLoad: number;
}

export interface AgentPoolConfig {
  agents: AgentInstanceConfig[];
}

const AGENT_CONFIG_FILE = FINGER_PATHS.config.file.agents;
const AGENT_PID_DIR = FINGER_PATHS.runtime.agentsDir;

const DEFAULT_AGENTS: AgentInstanceConfig[] = [
  {
    id: 'executor-default',
    name: 'Executor Default',
    mode: 'auto',
    port: 9101,
    autoStart: true,
    systemPrompt: 'You are the default execution agent in Finger runtime.',
  },
];

export class AgentPool {
  private static instance: AgentPool | null = null;
  private agents: Map<string, AgentInstance> = new Map();
  private config: AgentPoolConfig;

  static getInstance(): AgentPool {
    if (!AgentPool.instance) {
      AgentPool.instance = new AgentPool();
    }
    return AgentPool.instance;
  }

  constructor() {
    this.ensureDirs();
    this.config = this.loadConfig();
    this.loadFromConfig();
  }

  private ensureDirs(): void {
    ensureDir(FINGER_PATHS.config.dir);
    ensureDir(AGENT_PID_DIR);
  }

  private loadConfig(): AgentPoolConfig {
    if (fs.existsSync(AGENT_CONFIG_FILE)) {
      try {
        const content = fs.readFileSync(AGENT_CONFIG_FILE, 'utf-8');
        return JSON.parse(content) as AgentPoolConfig;
      } catch {
        console.error('[AgentPool] Failed to load config, fallback to default');
      }
    }

    const initial: AgentPoolConfig = { agents: DEFAULT_AGENTS };
    fs.writeFileSync(AGENT_CONFIG_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }

  private loadFromConfig(): void {
    for (const agentConfig of this.config.agents) {
      this.agents.set(agentConfig.id, {
        id: agentConfig.id,
        agentId: agentConfig.id,
        config: agentConfig,
        process: null,
        status: "stopped",
        currentLoad: 0
      });
    }
  }

  getAllInstances(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  getInstanceById(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  async spawnAgent(agentId: string, options?: { maxConcurrent?: number }): Promise<AgentInstance> {
    const existing = this.agents.get(agentId);
    if (existing) {
      if (existing.status === 'running') {
        return existing;
      }
      // Restart if stopped
      await this.startAgent(agentId);
      return this.agents.get(agentId)!;
    }

    // Create new agent instance
    const newConfig: AgentInstanceConfig = {
      id: agentId,
      name: agentId,
      mode: 'auto',
      port: 9100 + this.agents.size + 1,
      autoStart: true,
      systemPrompt: 'Default agent',
      ...options,
    };

    const instance: AgentInstance = {
      id: agentId,
      agentId: agentId,
      config: newConfig,
      process: null,
      status: "stopped",
      currentLoad: 0
    };

    this.agents.set(agentId, instance);
    await this.startAgent(agentId);
    return this.agents.get(agentId)!;
  }

  private async startAgent(agentId: string): Promise<void> {
    const instance = this.agents.get(agentId);
    if (!instance) return;

    instance.status = 'starting';
    
    try {
      // Lifecycle registration skipped

      instance.status = 'running';
      instance.startedAt = new Date();
    } catch (error) {
      instance.status = 'error';
      instance.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  killInstance(instanceId: string): boolean {
    const instance = this.agents.get(instanceId);
    if (!instance) return false;

    if (instance.process) {
      instance.process.kill('SIGTERM');
    }
    
    instance.status = 'stopped';
    instance.process = null;
    lifecycleManager.killProcess(instanceId, "stopped");
    return true;
  }

  async stopAll(): Promise<void> {
    for (const [id, instance] of this.agents) {
      if (instance.status === 'running') {
        await this.killInstance(id);
      }
    }
  }
}
