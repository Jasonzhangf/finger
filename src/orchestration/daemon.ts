import { spawn, ChildProcess } from 'child_process';
import { lifecycleManager } from '../agents/core/agent-lifecycle.js';
import { HeartbeatBroker, cleanupOrphanProcesses } from '../agents/core/agent-lifecycle.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { AgentPool } from './agent-pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DaemonConfig {
  pidFile: string;
  logFile: string;
  port: number;
  host: string;
  serverScript: string;
}

/**
 * Adapter interface for process operations - enables dependency injection for testing
 */
export interface ProcessAdapter {
  spawn: typeof spawn;
  isPidRunning: (pid: number) => boolean;
  killProcess: (id: string, reason: string) => void;
  registerProcess: (id: string, process: ChildProcess, type: string, metadata: Record<string, unknown>) => void;
  cleanupOrphans: () => { killed: string[]; errors: string[] };
}

/**
 * Adapter interface for filesystem operations
 */
export interface FsAdapter {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, content: string) => void;
  openSync: (path: string, flags: string) => number;
  unlinkSync: (path: string) => void;
}

/**
 * Default process adapter - uses real dependencies
 */
const defaultProcessAdapter: ProcessAdapter = {
  spawn: spawn,
  isPidRunning: (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  killProcess: (id: string, reason: string) => lifecycleManager.killProcess(id, reason),
  registerProcess: (id: string, proc: ChildProcess, type: string, metadata: Record<string, unknown>) => 
    lifecycleManager.registerProcess(id, proc, type as 'iflow-cli' | 'browser' | 'other', metadata),
  cleanupOrphans: cleanupOrphanProcesses,
};

/**
 * Default filesystem adapter - uses real fs module
 */
const defaultFsAdapter: FsAdapter = {
  existsSync: fs.existsSync,
  mkdirSync: (p: string, options?: { recursive?: boolean }) => fs.mkdirSync(p, options),
  readFileSync: (p: string, encoding: string) => fs.readFileSync(p, encoding as BufferEncoding),
  writeFileSync: fs.writeFileSync,
  openSync: fs.openSync,
  unlinkSync: fs.unlinkSync,
};

export class OrchestrationDaemon {
  private process: ChildProcess | null = null;
  private config: DaemonConfig;
  private running = false;
  private agentPool: AgentPool;
  private heartbeatBroker: HeartbeatBroker;
  private processAdapter: ProcessAdapter;
  private fsAdapter: FsAdapter;

  constructor(
    config?: Partial<DaemonConfig>,
    processAdapter?: ProcessAdapter,
    fsAdapter?: FsAdapter
  ) {
    const home = os.homedir();
    const fingerDir = path.join(home, '.finger');
    this.config = {
      pidFile: path.join(fingerDir, 'daemon.pid'),
      logFile: path.join(fingerDir, 'daemon.log'),
      port: 5521,
      host: 'localhost',
      serverScript: path.resolve(__dirname, '../server/index.js'),
      ...config
    };

    this.processAdapter = processAdapter ?? defaultProcessAdapter;
    this.fsAdapter = fsAdapter ?? defaultFsAdapter;

    if (!this.fsAdapter.existsSync(fingerDir)) {
      this.fsAdapter.mkdirSync(fingerDir, { recursive: true });
    }

    this.agentPool = new AgentPool();
    this.heartbeatBroker = new HeartbeatBroker();
  }

  async start(): Promise<void> {
    if (this.running) {
      console.log('Daemon already running (in-process)');
      return;
    }

    // Clean up orphan processes from previous sessions
    const orphans = this.processAdapter.cleanupOrphans();
    if (orphans.killed.length > 0) {
      console.log(`[Daemon] Cleaned up ${orphans.killed.length} orphan processes: ${orphans.killed.join(', ')}`);
    }
    if (orphans.errors.length > 0) {
      console.error('[Daemon] Errors during orphan cleanup:', orphans.errors);
    }

    if (this.fsAdapter.existsSync(this.config.pidFile)) {
      const pid = parseInt(this.fsAdapter.readFileSync(this.config.pidFile, 'utf-8'), 10);
      if (Number.isFinite(pid)) {
        if (this.processAdapter.isPidRunning(pid)) {
          console.log(`Daemon already running with PID ${pid}`);
          this.running = true;
          return;
        } else {
          this.fsAdapter.unlinkSync(this.config.pidFile);
        }
      }
    }

    const serverPath = this.config.serverScript;
    if (!this.fsAdapter.existsSync(serverPath)) {
      console.error(`Server script not found: ${serverPath}. Build first with 'npm run build'.`);
      return;
    }

    const logFd = this.fsAdapter.openSync(this.config.logFile, 'a');
    this.process = this.processAdapter.spawn('node', [serverPath], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        FINGER_DAEMON: '1',
        PORT: this.config.port.toString(),
        HOST: this.config.host
      }
    });

    this.process.unref();
    
    // Register with lifecycle manager
    this.processAdapter.registerProcess('daemon-server', this.process, 'other', {
      type: 'orchestration-daemon'
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.process?.pid) {
          this.fsAdapter.writeFileSync(this.config.pidFile, this.process.pid.toString());
          this.running = true;
          console.log(`Daemon started with PID ${this.process.pid}`);
          resolve();
        }
      }, 500);
    });

    // 启动自动启动的 runtime agents
    console.log('[Daemon] Starting auto-start agents...');
    await this.agentPool.startAllAuto();

    // Start heartbeat broadcaster
    this.heartbeatBroker.start();
    console.log('[Daemon] Heartbeat broadcaster started');
  }

  async stop(): Promise<void> {
    // 先停止所有 runtime agents
    console.log('[Daemon] Stopping runtime agents...');
    await this.agentPool.stopAll();

    // Stop heartbeat broadcaster
    this.heartbeatBroker.stop();

    if (!this.fsAdapter.existsSync(this.config.pidFile)) {
      console.log('No PID file found, daemon not running');
      return;
    }

    const pid = parseInt(this.fsAdapter.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      this.fsAdapter.unlinkSync(this.config.pidFile);
      console.log('Invalid PID file removed');
      return;
    }

    // Use lifecycle manager for proper cleanup
    this.processAdapter.killProcess('daemon-server', 'user-request');
    
    if (this.fsAdapter.existsSync(this.config.pidFile)) {
      this.fsAdapter.unlinkSync(this.config.pidFile);
    }
    this.running = false;
    console.log(`Daemon stopped`);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  isRunning(): boolean {
    if (!this.fsAdapter.existsSync(this.config.pidFile)) {
      return false;
    }

    const pid = parseInt(this.fsAdapter.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      this.fsAdapter.unlinkSync(this.config.pidFile);
      return false;
    }

    const running = this.processAdapter.isPidRunning(pid);
    if (!running) {
      this.fsAdapter.unlinkSync(this.config.pidFile);
    }
    return running;
  }

  getAgentPool(): AgentPool {
    return this.agentPool;
  }

  /**
   * Get the running state (for testing)
   */
  getRunningState(): boolean {
    return this.running;
  }

  /**
   * Set the running state (for testing)
   */
  setRunningState(running: boolean): void {
    this.running = running;
  }
}
