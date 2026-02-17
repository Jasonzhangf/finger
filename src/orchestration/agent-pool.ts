import { spawn, ChildProcess } from 'child_process';
import { lifecycleManager } from '../agents/core/agent-lifecycle.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  config: AgentInstanceConfig;
  process: ChildProcess | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  lastError?: string;
  startedAt?: Date;
  pid?: number;
}

export interface AgentPoolConfig {
  agents: AgentInstanceConfig[];
}

const FINGER_HOME = path.join(os.homedir(), '.finger');
const AGENT_CONFIG_FILE = path.join(FINGER_HOME, 'agents.json');
const AGENT_PID_DIR = path.join(FINGER_HOME, 'agents');

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
  private agents: Map<string, AgentInstance> = new Map();
  private config: AgentPoolConfig;

  constructor() {
    this.ensureDirs();
    this.config = this.loadConfig();
    this.loadFromConfig();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(FINGER_HOME)) {
      fs.mkdirSync(FINGER_HOME, { recursive: true });
    }
    if (!fs.existsSync(AGENT_PID_DIR)) {
      fs.mkdirSync(AGENT_PID_DIR, { recursive: true });
    }
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

  private saveConfig(): void {
    fs.writeFileSync(AGENT_CONFIG_FILE, JSON.stringify(this.config, null, 2));
  }

  private loadFromConfig(): void {
    this.agents.clear();
    for (const agentConfig of this.config.agents) {
      this.agents.set(agentConfig.id, {
        config: agentConfig,
        process: null,
        status: 'stopped',
      });
    }
    this.refreshAllStatuses();
  }

  private getPidFile(agentId: string): string {
    return path.join(AGENT_PID_DIR, `${agentId}.pid`);
  }

  private getLogFile(agentId: string): string {
    return path.join(AGENT_PID_DIR, `${agentId}.log`);
  }

  private isPidRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private refreshStatus(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const pidFile = this.getPidFile(agentId);
    if (!fs.existsSync(pidFile)) {
      agent.status = 'stopped';
      agent.pid = undefined;
      return;
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(pidFile);
      agent.status = 'stopped';
      agent.pid = undefined;
      return;
    }

    if (this.isPidRunning(pid)) {
      agent.status = 'running';
      agent.pid = pid;
      return;
    }

    fs.unlinkSync(pidFile);
    agent.status = 'stopped';
    agent.pid = undefined;
  }

  private refreshAllStatuses(): void {
    for (const id of this.agents.keys()) {
      this.refreshStatus(id);
    }
  }

  private async waitForHealth(port: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          return true;
        }
      } catch {
        // wait and retry
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return false;
  }

  getConfigs(): AgentInstanceConfig[] {
    return [...this.config.agents];
  }

  addAgent(config: AgentInstanceConfig): void {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent ${config.id} already exists`);
    }

    this.config.agents.push(config);
    this.saveConfig();

    this.agents.set(config.id, {
      config,
      process: null,
      status: 'stopped',
    });

    console.log(`[AgentPool] Agent ${config.id} added`);
  }

  async removeAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    this.refreshStatus(agentId);
    if (agent.status === 'running') {
      await this.stopAgent(agentId);
    }

    this.config.agents = this.config.agents.filter(a => a.id !== agentId);
    this.saveConfig();
    this.agents.delete(agentId);

    console.log(`[AgentPool] Agent ${agentId} removed`);
  }

  async startAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    this.refreshStatus(agentId);
    if (agent.status === 'running') {
      console.log(`[AgentPool] Agent ${agentId} already running`);
      return;
    }

    const pidFile = this.getPidFile(agentId);
    const logFile = this.getLogFile(agentId);
    const logFd = fs.openSync(logFile, 'a');
    const cliScript = path.resolve(__dirname, '../agents/daemon/agent-daemon-cli.js');

    const args = [
      cliScript,
      'start',
      '--id', agent.config.id,
      '--name', agent.config.name,
      '--mode', agent.config.mode,
      '--port', agent.config.port.toString(),
      '--finger-daemon-url', 'http://localhost:5521',
    ];

    if (agent.config.systemPrompt) {
      args.push('--system-prompt', agent.config.systemPrompt);
    }

    if (agent.config.cwd) {
      args.push('--cwd', agent.config.cwd);
    }

    agent.status = 'starting';

    const child = spawn('node', args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env }
    });

    child.unref();
    
    // Register with lifecycle manager for proper cleanup
    lifecycleManager.registerProcess(`agent-${agentId}`, child, 'other', { 
      type: 'agent-runner', 
      agentId 
    });

    // 监听子进程退出，清理状态
    child.on('exit', (code, signal) => {
      console.log(`[AgentPool] Agent ${agentId} exited with code ${code}, signal ${signal}`);
      agent.status = 'stopped';
      agent.process = null;
      agent.pid = undefined;
      
      // 清理PID文件
      const pidFile = this.getPidFile(agentId);
      try {
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
        }
      } catch {
        // ignore
      }
    });

    // 监听错误
    child.on('error', (err) => {
      console.error(`[AgentPool] Agent ${agentId} error:`, err.message);
      agent.status = 'error';
      agent.lastError = err.message;
      agent.process = null;
      agent.pid = undefined;
    });

    if (!child.pid) {
      agent.status = 'error';
      agent.lastError = 'Spawn failed: no child pid';
      throw new Error(`[AgentPool] Failed to spawn ${agentId}`);
    }

    fs.writeFileSync(pidFile, child.pid.toString());
    agent.process = child;
    agent.pid = child.pid;

    const healthy = await this.waitForHealth(agent.config.port);
    if (!healthy) {
      agent.status = 'error';
      agent.lastError = 'Health check timeout';
      throw new Error(`[AgentPool] Agent ${agentId} started but health check failed`);
    }

    agent.status = 'running';
    agent.startedAt = new Date();
    agent.lastError = undefined;

    console.log(`[AgentPool] Agent ${agentId} started with PID ${child.pid}`);
  }

  async stopAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pidFile = this.getPidFile(agentId);
    if (!fs.existsSync(pidFile)) {
      agent.status = 'stopped';
      agent.pid = undefined;
      console.log(`[AgentPool] Agent ${agentId} not running`);
      return;
    }

    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(pidFile);
      agent.status = 'stopped';
      agent.pid = undefined;
      return;
    }

    // Use lifecycle manager for proper cleanup
    lifecycleManager.killProcess(`agent-${agentId}`, 'user-request');

    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }

    await new Promise(resolve => setTimeout(resolve, 300));

    agent.status = 'stopped';
    agent.process = null;
    agent.pid = undefined;

    console.log(`[AgentPool] Agent ${agentId} stopped`);
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.stopAgent(agentId);
    await this.startAgent(agentId);
  }

  getAgentStatus(agentId: string): AgentInstance | undefined {
    this.refreshStatus(agentId);
    return this.agents.get(agentId);
  }

  listAgents(): AgentInstance[] {
    this.refreshAllStatuses();
    return Array.from(this.agents.values());
  }

  async startAllAuto(): Promise<void> {
    for (const agent of this.config.agents) {
      if (!agent.autoStart) {
        continue;
      }
      try {
        await this.startAgent(agent.id);
      } catch (err) {
        console.error(`[AgentPool] Failed to auto-start ${agent.id}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    const running = this.listAgents().filter(a => a.status === 'running').map(a => a.config.id);
    await Promise.all(running.map(id => this.stopAgent(id).catch(err => {
      console.error(`[AgentPool] Failed to stop ${id}:`, err);
    })));
  }
}
