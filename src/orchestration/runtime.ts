/**
 * Runtime - Agent lifecycle manager
 *
 * Implements RUNTIME_SPEC.md section 5 requirements:
 * - Agent lifecycle state transitions
 * - Health check timer
 * - Auto-restart with backoff
 * - Agent history persistence
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lifecycleManager } from '../agents/core/agent-lifecycle.js';

export type AgentLifecycleState =
  | 'REGISTERED'
  | 'STARTING'
  | 'RUNNING'
  | 'BUSY'
  | 'IDLE'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED';

export interface AgentHistoryEntry {
  agentId: string;
  timestamp: number;
  event: 'register' | 'start' | 'stop' | 'restart' | 'crash' | 'health_check_failed';
  pid?: number;
  reason?: string;
  exitCode?: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  port: number;
  command: string;
  args?: string[];
  autoStart?: boolean;
  autoRestart?: boolean;
  maxRestarts?: number;
  restartBackoffMs?: number;
  healthCheckIntervalMs?: number;
  healthCheckTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
}

export interface AgentRuntimeState {
  config: Required<Pick<
    AgentConfig,
    | 'id'
    | 'name'
    | 'port'
    | 'command'
    | 'args'
    | 'autoStart'
    | 'autoRestart'
    | 'maxRestarts'
    | 'restartBackoffMs'
    | 'healthCheckIntervalMs'
    | 'healthCheckTimeoutMs'
    | 'heartbeatTimeoutMs'
  >>;
  state: AgentLifecycleState;
  process: ChildProcess | null;
  pid: number | null;
  restartCount: number;
  lastRestartTime: number;
  startTime: number | null;
  stopTime: number | null;
  lastHealthCheck: number;
  lastHeartbeat: number;
}

export interface RuntimeConfig {
  historyFile?: string;
  defaultHealthCheckIntervalMs?: number;
  defaultHealthCheckTimeoutMs?: number;
  defaultHeartbeatTimeoutMs?: number;
  defaultMaxRestarts?: number;
  defaultRestartBackoffMs?: number;
}

export interface HealthChecker {
  check(agentId: string, port: number, timeoutMs: number): Promise<boolean>;
}

class DefaultHealthChecker implements HealthChecker {
  async check(_agentId: string, port: number, timeoutMs: number): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export class AgentRuntime {
  private agents = new Map<string, AgentRuntimeState>();
  private healthTimers = new Map<string, NodeJS.Timeout>();
  private history: AgentHistoryEntry[] = [];
  private historyFile: string;
  private healthChecker: HealthChecker;
  private defaults: Required<Pick<
    AgentConfig,
    | 'args'
    | 'autoStart'
    | 'autoRestart'
    | 'maxRestarts'
    | 'restartBackoffMs'
    | 'healthCheckIntervalMs'
    | 'healthCheckTimeoutMs'
    | 'heartbeatTimeoutMs'
  >>;

  constructor(config: RuntimeConfig = {}, checker?: HealthChecker) {
    const fingerDir = path.join(os.homedir(), '.finger');
    this.historyFile = config.historyFile || path.join(fingerDir, 'agent-history.json');
    this.healthChecker = checker ?? new DefaultHealthChecker();

    this.defaults = {
      args: [],
      autoStart: false,
      autoRestart: true,
      maxRestarts: config.defaultMaxRestarts ?? 3,
      restartBackoffMs: config.defaultRestartBackoffMs ?? 1000,
      healthCheckIntervalMs: config.defaultHealthCheckIntervalMs ?? 30000,
      healthCheckTimeoutMs: config.defaultHealthCheckTimeoutMs ?? 5000,
      heartbeatTimeoutMs: config.defaultHeartbeatTimeoutMs ?? 60000,
    };

    this.loadHistory();
  }

  setHealthChecker(checker: HealthChecker): void {
    this.healthChecker = checker;
  }

  register(config: AgentConfig): void {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent ${config.id} already registered`);
    }

    const normalized: AgentRuntimeState['config'] = {
      id: config.id,
      name: config.name,
      port: config.port,
      command: config.command,
      args: config.args ?? this.defaults.args,
      autoStart: config.autoStart ?? this.defaults.autoStart,
      autoRestart: config.autoRestart ?? this.defaults.autoRestart,
      maxRestarts: config.maxRestarts ?? this.defaults.maxRestarts,
      restartBackoffMs: config.restartBackoffMs ?? this.defaults.restartBackoffMs,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? this.defaults.healthCheckIntervalMs,
      healthCheckTimeoutMs: config.healthCheckTimeoutMs ?? this.defaults.healthCheckTimeoutMs,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? this.defaults.heartbeatTimeoutMs,
    };

    this.agents.set(config.id, {
      config: normalized,
      state: 'REGISTERED',
      process: null,
      pid: null,
      restartCount: 0,
      lastRestartTime: 0,
      startTime: null,
      stopTime: null,
      lastHealthCheck: 0,
      lastHeartbeat: 0,
    });

    this.recordHistory(config.id, 'register', { reason: 'registered' });
  }

  async start(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Agent ${agentId} not registered`);
    if (state.state === 'RUNNING' || state.state === 'STARTING') return;

    state.state = 'STARTING';

    const proc = spawn(state.config.command, state.config.args, {
      env: {
        ...process.env,
        AGENT_ID: agentId,
        AGENT_PORT: String(state.config.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    state.process = proc;
    state.pid = proc.pid ?? null;
    state.startTime = Date.now();
    state.stopTime = null;
    state.lastHeartbeat = Date.now();

    lifecycleManager.registerProcess(agentId, proc, 'other', {
      type: 'agent',
      port: state.config.port,
    });

    proc.on('exit', (code, signal) => {
      this.handleExit(agentId, code, signal);
    });

    proc.on('error', (err: Error) => {
      state.state = 'FAILED';
      this.recordHistory(agentId, 'crash', { reason: err.message });
    });

    state.state = 'RUNNING';
    this.recordHistory(agentId, 'start', { pid: state.pid ?? undefined });
    this.startHealthCheck(agentId);
  }

  async stop(agentId: string, reason = 'user-request'): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) return;

    // Always stop timer even if process is already null.
    this.stopHealthCheck(agentId);

    if (!state.process) {
      state.state = 'STOPPED';
      state.stopTime = Date.now();
      return;
    }

    state.state = 'STOPPING';

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };

      const timer = setTimeout(() => {
        if (state.pid) {
          try {
            process.kill(state.pid, 'SIGKILL');
          } catch {
            // Ignore
          }
        }
        finish();
      }, 5000);

      state.process?.once('exit', () => {
        clearTimeout(timer);
        finish();
      });

      try {
        state.process?.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        finish();
      }
    });

    state.state = 'STOPPED';
    state.stopTime = Date.now();
    state.process = null;
    state.pid = null;
    this.recordHistory(agentId, 'stop', { reason });
  }

  async restart(agentId: string, reason = 'manual'): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Agent ${agentId} not registered`);

    if (state.restartCount >= state.config.maxRestarts) {
      state.state = 'FAILED';
      this.recordHistory(agentId, 'crash', { reason: 'max_restarts_exceeded' });
      return;
    }

    const delay = Math.min(
      state.config.restartBackoffMs * Math.pow(2, state.restartCount),
      30000
    );

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), delay);
    });

    state.restartCount += 1;
    state.lastRestartTime = Date.now();

    await this.stop(agentId, reason);
    await this.start(agentId);
    this.recordHistory(agentId, 'restart', { reason });
  }

  updateHeartbeat(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.lastHeartbeat = Date.now();
  }

  getState(agentId: string): AgentRuntimeState | undefined {
    return this.agents.get(agentId);
  }

  getAllStates(): Map<string, AgentRuntimeState> {
    return new Map(this.agents);
  }

  getHistory(agentId?: string): AgentHistoryEntry[] {
    if (!agentId) return [...this.history];
    return this.history.filter((h) => h.agentId === agentId);
  }

  async stopAll(): Promise<void> {
    const tasks = Array.from(this.agents.keys()).map((id) => this.stop(id, 'shutdown'));
    await Promise.all(tasks);
  }

  private handleExit(agentId: string, code: number | null, signal: string | null): void {
    const state = this.agents.get(agentId);
    if (!state) return;

    this.stopHealthCheck(agentId);

    if (code === 0) {
      state.state = 'STOPPED';
      this.recordHistory(agentId, 'stop', { exitCode: 0, reason: signal ?? 'normal' });
      state.process = null;
      state.pid = null;
      state.stopTime = Date.now();
      return;
    }

    this.recordHistory(agentId, 'crash', {
      exitCode: code ?? undefined,
      reason: signal ?? 'crash',
    });

    if (state.config.autoRestart && state.restartCount < state.config.maxRestarts) {
      void this.restart(agentId, 'auto-restart');
      return;
    }

    state.state = 'FAILED';
    state.process = null;
    state.pid = null;
    state.stopTime = Date.now();
  }

  private startHealthCheck(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;

    this.stopHealthCheck(agentId);

    const timer = setInterval(() => {
      void this.performHealthCheck(agentId);
    }, state.config.healthCheckIntervalMs);

    this.healthTimers.set(agentId, timer);
  }

  private stopHealthCheck(agentId: string): void {
    const timer = this.healthTimers.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.healthTimers.delete(agentId);
    }
  }

  private async performHealthCheck(agentId: string): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state || state.state !== 'RUNNING') return;

    state.lastHealthCheck = Date.now();

    const heartbeatAge = Date.now() - state.lastHeartbeat;
    if (heartbeatAge > state.config.heartbeatTimeoutMs) {
      this.recordHistory(agentId, 'health_check_failed', { reason: 'heartbeat_timeout' });
      if (state.config.autoRestart) {
        await this.restart(agentId, 'heartbeat-timeout');
      }
      return;
    }

    const healthy = await this.healthChecker.check(
      agentId,
      state.config.port,
      state.config.healthCheckTimeoutMs
    );

    if (!healthy) {
      this.recordHistory(agentId, 'health_check_failed', { reason: 'health_check_failed' });
    }
  }

  private recordHistory(
    agentId: string,
    event: AgentHistoryEntry['event'],
    details: { pid?: number; reason?: string; exitCode?: number } = {}
  ): void {
    this.history.push({
      agentId,
      timestamp: Date.now(),
      event,
      ...details,
    });
    this.saveHistory();
  }

  private loadHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) return;
      const raw = fs.readFileSync(this.historyFile, 'utf-8');
      this.history = JSON.parse(raw) as AgentHistoryEntry[];
    } catch {
      this.history = [];
    }
  }

  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const trimmed = this.history.slice(-1000);
      fs.writeFileSync(this.historyFile, JSON.stringify(trimmed, null, 2));
    } catch {
      // Ignore persistence errors.
    }
  }
}

export const agentRuntime = new AgentRuntime();
