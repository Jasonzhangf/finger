/**
 * AgentProcess - 独立 Agent CLI 进程管理
 * 
 * 功能:
 * 1. 每个 Agent 作为独立 CLI 进程启动
 * 2. 向 Daemon 注册心跳
 * 3. 心跳失败自动退出（自杀）
 * 4. 接收 Daemon 信号优雅退出
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentProcess');

export interface AgentProcessConfig {
  agentId: string;
  agentName: string;
  entryScript: string;  // Agent CLI 入口脚本路径
  args?: string[];
  env?: Record<string, string>;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  autoRestart?: boolean;
  maxRestarts?: number;
}

export interface AgentProcessInfo {
  pid: number;
  agentId: string;
  status: 'starting' | 'running' | 'stopped' | 'crashed' | 'restarting';
  startTime: Date;
  lastHeartbeat: Date | null;
  restartCount: number;
  exitCode?: number | null;
  exitSignal?: string | null;
}

export class AgentProcess extends EventEmitter {
  private config: AgentProcessConfig;
  private process: ChildProcess | null = null;
  private info: AgentProcessInfo;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(config: AgentProcessConfig) {
    super();
    this.config = {
      heartbeatIntervalMs: 30000,  // 30s
      heartbeatTimeoutMs: 60000,   // 60s
      autoRestart: true,
      maxRestarts: 3,
      ...config,
    };
    this.info = {
      pid: 0,
      agentId: config.agentId,
      status: 'starting',
      startTime: new Date(),
      lastHeartbeat: null,
      restartCount: 0,
    };
  }

  /**
   * 启动 Agent CLI 进程
   */
  async start(): Promise<AgentProcessInfo> {
    if (this.process) {
      throw new Error(`Agent ${this.config.agentId} already running`);
    }

    log.info(`Starting agent process: ${this.config.agentId}`);

    const env = {
      ...process.env,
      AGENT_ID: this.config.agentId,
      AGENT_NAME: this.config.agentName,
      DAEMON_PID: String(process.pid),
      HEARTBEAT_INTERVAL_MS: String(this.config.heartbeatIntervalMs),
      ...this.config.env,
    };

    this.process = spawn('node', [this.config.entryScript, ...(this.config.args || [])], {
      env,
      detached: false,  // 不分离，确保子进程随父进程退出
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.info.pid = this.process.pid || 0;
    this.info.status = 'running';
    this.info.startTime = new Date();
    this.isShuttingDown = false;

    // 监听输出
    this.process.stdout?.on('data', (data) => {
      log.debug(`[${this.config.agentId}] stdout: ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data) => {
      log.warn(`[${this.config.agentId}] stderr: ${data.toString().trim()}`);
    });

    // 监听退出
    this.process.on('exit', (code, signal) => {
      this.handleExit(code, signal);
    });

    // 启动心跳检查
    this.startHeartbeatCheck();

    log.info(`Agent process started: ${this.config.agentId} (PID: ${this.info.pid})`);
    this.emit('started', this.info);

    return this.info;
  }

  /**
   * 停止 Agent 进程
   */
  async stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!this.process) return;

    log.info(`Stopping agent process: ${this.config.agentId}`);
    this.isShuttingDown = true;

    // 清除定时器
    this.clearTimers();

    // 发送优雅退出信号
    this.process.kill(signal);

    // 等待进程退出
    const timeout = setTimeout(() => {
      if (this.process && !this.process.killed) {
        log.warn(`Agent ${this.config.agentId} did not exit gracefully, forcing SIGKILL`);
        this.process.kill('SIGKILL');
      }
    }, 5000);

    return new Promise((resolve) => {
      this.process?.once('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this.info.status = 'stopped';
        resolve();
      });
    });
  }

  /**
   * 更新心跳时间戳
   */
  updateHeartbeat(): void {
    this.info.lastHeartbeat = new Date();
    log.debug(`Heartbeat received from ${this.config.agentId}`);
  }

  /**
   * 获取进程信息
   */
  getInfo(): AgentProcessInfo {
    return { ...this.info };
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.process !== null && this.info.status === 'running';
  }

  /**
   * 处理进程退出
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.clearTimers();
    this.process = null;

    this.info.exitCode = code;
    this.info.exitSignal = signal;

    const isCrash = code !== 0 && code !== null;
    this.info.status = isCrash ? 'crashed' : 'stopped';

    log.info(`Agent process exited: ${this.config.agentId} (code: ${code}, signal: ${signal})`);
    this.emit('exited', this.info);

    // 自动重启逻辑
    if (!this.isShuttingDown && this.config.autoRestart && isCrash) {
      if (this.info.restartCount < (this.config.maxRestarts || 3)) {
        this.info.restartCount++;
        log.info(`Auto-restarting agent: ${this.config.agentId} (attempt ${this.info.restartCount})`);
        this.info.status = 'restarting';
        setTimeout(() => this.start(), 1000);
      } else {
        log.error(`Agent ${this.config.agentId} exceeded max restarts (${this.config.maxRestarts})`);
      }
    }
  }

  /**
   * 启动心跳检查定时器
   */
  private startHeartbeatCheck(): void {
    const checkInterval = this.config.heartbeatIntervalMs || 30000;
    const timeout = this.config.heartbeatTimeoutMs || 60000;

    this.checkTimer = setInterval(() => {
      if (!this.info.lastHeartbeat) {
        // 首次心跳还未收到
        const uptime = Date.now() - this.info.startTime.getTime();
        if (uptime > timeout) {
          log.error(`Agent ${this.config.agentId} never sent heartbeat, killing`);
          this.stop('SIGKILL');
        }
        return;
      }

      const lastHb = this.info.lastHeartbeat.getTime();
      const elapsed = Date.now() - lastHb;

      if (elapsed > timeout) {
        log.error(`Agent ${this.config.agentId} heartbeat timeout (${elapsed}ms), killing`);
        this.stop('SIGKILL');
      }
    }, checkInterval);
  }

  /**
   * 清除定时器
   */
  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}

export default AgentProcess;
