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

export class OrchestrationDaemon {
  private process: ChildProcess | null = null;
  private config: DaemonConfig;
  private running = false;
  private agentPool: AgentPool;
  private heartbeatBroker: HeartbeatBroker;

  constructor(config?: Partial<DaemonConfig>) {
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

    if (!fs.existsSync(fingerDir)) {
      fs.mkdirSync(fingerDir, { recursive: true });
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
    const orphans = cleanupOrphanProcesses();
    if (orphans.killed.length > 0) {
      console.log(`[Daemon] Cleaned up ${orphans.killed.length} orphan processes: ${orphans.killed.join(', ')}`);
    }
    if (orphans.errors.length > 0) {
      console.error('[Daemon] Errors during orphan cleanup:', orphans.errors);
    }

    if (fs.existsSync(this.config.pidFile)) {
      const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`Daemon already running with PID ${pid}`);
          this.running = true;
          return;
        } catch {
          fs.unlinkSync(this.config.pidFile);
        }
      }
    }

    const serverPath = this.config.serverScript;
    if (!fs.existsSync(serverPath)) {
      console.error(`Server script not found: ${serverPath}. Build first with 'npm run build'.`);
      return;
    }

    const logFd = fs.openSync(this.config.logFile, 'a');
    this.process = spawn('node', [serverPath], {
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
    lifecycleManager.registerProcess('daemon-server', this.process, 'other', {
      type: 'orchestration-daemon'
    });

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        if (this.process?.pid) {
          fs.writeFileSync(this.config.pidFile, this.process.pid.toString());
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

    if (!fs.existsSync(this.config.pidFile)) {
      console.log('No PID file found, daemon not running');
      return;
    }

    const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(this.config.pidFile);
      console.log('Invalid PID file removed');
      return;
    }

    // Use lifecycle manager for proper cleanup
    lifecycleManager.killProcess('daemon-server', 'user-request');
    
    if (fs.existsSync(this.config.pidFile)) {
      fs.unlinkSync(this.config.pidFile);
    }
    this.running = false;
    console.log(`Daemon stopped`);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  isRunning(): boolean {
    if (!fs.existsSync(this.config.pidFile)) {
      return false;
    }

    const pid = parseInt(fs.readFileSync(this.config.pidFile, 'utf-8'), 10);
    if (!Number.isFinite(pid)) {
      fs.unlinkSync(this.config.pidFile);
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      fs.unlinkSync(this.config.pidFile);
      return false;
    }
  }

  getAgentPool(): AgentPool {
    return this.agentPool;
  }
}
