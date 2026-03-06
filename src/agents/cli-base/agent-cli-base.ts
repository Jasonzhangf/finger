/**
 * AgentCLIBase - Agent CLI 基类
 * 
 * 每个 Agent 作为独立 CLI 进程运行:
 * 1. 启动时向 Daemon 注册
 * 2. 监听 Daemon 心跳
 * 3. 连续 N 次未收到心跳自动退出
 * 4. 接收信号优雅退出
 */

import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';
import type { MessageHub } from '../../orchestration/message-hub.js';

const log = logger.module('AgentCLI');

export interface AgentCLIConfig {
  agentId: string;
  agentName: string;
  daemonUrl: string;
  heartbeatTimeoutMs: number;  // 心跳超时时间
  maxMissedHeartbeats: number; // 最大允许错过心跳次数
  capabilities?: string[];
}

export abstract class AgentCLIBase extends EventEmitter {
  protected config: AgentCLIConfig;
  protected hub: MessageHub | null = null;
  protected isRunning = false;
  protected isShuttingDown = false;
  protected lastHeartbeat: Date | null = null;
  protected missedHeartbeats = 0;
  protected heartbeatCheckTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<AgentCLIConfig> & { agentId: string; agentName: string }) {
    super();
    this.config = {
      daemonUrl: 'http://localhost:9999',
      heartbeatTimeoutMs: 60000,     // 60s
      maxMissedHeartbeats: 3,        // 3次
      capabilities: [],
      ...config,
    };
  }

  /**
   * 启动 Agent CLI
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error(`Agent ${this.config.agentId} already running`);
    }

    log.info(`Starting Agent CLI: ${this.config.agentId}`);
    this.isRunning = true;
    this.isShuttingDown = false;

    // 1. 设置信号处理
    this.setupSignalHandlers();

    // 2. 向 Daemon 注册
    await this.registerWithDaemon();

    // 3. 启动心跳监听
    this.startHeartbeatMonitor();

    // 4. 初始化具体 Agent 逻辑
    await this.initialize();

    // 5. 启动主循环
    await this.runLoop();

    log.info(`Agent CLI started: ${this.config.agentId}`);
    this.emit('started');
  }

  /**
   * 停止 Agent CLI
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    log.info(`Stopping Agent CLI: ${this.config.agentId}`);
    this.isShuttingDown = true;

    // 停止心跳监听
    this.stopHeartbeatMonitor();

    // 清理具体 Agent 资源
    await this.cleanup();

    // 向 Daemon 注销
    await this.unregisterFromDaemon();

    this.isRunning = false;
    log.info(`Agent CLI stopped: ${this.config.agentId}`);
    this.emit('stopped');
  }

  /**
   * 子类实现：初始化逻辑
   */
  protected abstract initialize(): Promise<void>;

  /**
   * 子类实现：主循环逻辑
   */
  protected abstract runLoop(): Promise<void>;

  /**
   * 子类实现：清理逻辑
   */
  protected async cleanup(): Promise<void> {}

  /**
   * 收到心跳回调
   */
  onHeartbeatReceived(): void {
    this.lastHeartbeat = new Date();
    this.missedHeartbeats = 0;
    log.debug(`Heartbeat received, reset counter`);
  }

  /**
   * 设置信号处理
   */
  private setupSignalHandlers(): void {
    const handleSignal = async (signal: NodeJS.Signals) => {
      log.info(`Received signal: ${signal}`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', handleSignal);
    process.on('SIGINT', handleSignal);
    process.on('SIGHUP', handleSignal);

    process.on('uncaughtException', async (error) => {
      log.error(`Uncaught exception in ${this.config.agentId}:`, error);
      await this.stop();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason) => {
      log.error(`Unhandled rejection in ${this.config.agentId}:`, reason as Error);
      await this.stop();
      process.exit(1);
    });
  }

  /**
   * 向 Daemon 注册
   */
  private async registerWithDaemon(): Promise<void> {
    try {
      const response = await fetch(`${this.config.daemonUrl}/api/v1/agents/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: this.config.agentId,
          agentName: this.config.agentName,
          pid: process.pid,
          capabilities: this.config.capabilities,
          startTime: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Registration failed: ${response.status}`);
      }

      log.info(`Registered with daemon: ${this.config.agentId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Failed to register with daemon: ${err.message}`);
    }
  }

  /**
   * 向 Daemon 注销
   */
  private async unregisterFromDaemon(): Promise<void> {
    try {
      await fetch(`${this.config.daemonUrl}/api/v1/agents/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: this.config.agentId,
          pid: process.pid,
          reason: 'shutdown',
        }),
      });
      log.info(`Unregistered from daemon: ${this.config.agentId}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn(`Failed to unregister from daemon: ${err.message}`);
    }
  }

  /**
   * 启动心跳监听
   */
  private startHeartbeatMonitor(): void {
    const checkInterval = this.config.heartbeatTimeoutMs / (this.config.maxMissedHeartbeats + 1);

    this.heartbeatCheckTimer = setInterval(() => {
      this.checkHeartbeat();
    }, checkInterval);

    log.info(`Heartbeat monitor started (interval: ${checkInterval}ms, max misses: ${this.config.maxMissedHeartbeats})`);
  }

  /**
   * 停止心跳监听
   */
  private stopHeartbeatMonitor(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
  }

  /**
   * 检查心跳
   */
  private checkHeartbeat(): void {
    if (this.isShuttingDown) return;

    this.missedHeartbeats++;
    log.debug(`Heartbeat check: missed ${this.missedHeartbeats}/${this.config.maxMissedHeartbeats}`);

    if (this.missedHeartbeats >= this.config.maxMissedHeartbeats) {
      log.error(`Missed ${this.missedHeartbeats} heartbeats, self-terminating`);
      this.stop().then(() => process.exit(1));
    }
  }

  getConfig(): AgentCLIConfig {
    return { ...this.config };
  }

  getIsRunning(): boolean {
    return this.isRunning;
  }
}

export default AgentCLIBase;
