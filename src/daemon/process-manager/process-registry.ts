/**
 * ProcessRegistry - 进程注册表
 * 
 * 管理所有 Agent 进程的生命周期:
 * 1. 启动时自动加载 autostart 目录
 * 2. 注册心跳监听
 * 3. 心跳超时清理孤儿进程
 * 4. 热插拔支持
 */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { AgentProcess, type AgentProcessConfig, type AgentProcessInfo } from './agent-process.js';

const log = logger.module('ProcessRegistry');

export interface RegistryConfig {
  autostartDir: string;
  heartbeatTimeoutMs: number;
  autoStartOnBoot: boolean;
}

export interface AgentRegistration {
  agentId: string;
  agentName: string;
  pid: number;
  status: 'registered' | 'running' | 'stopped' | 'crashed';
  registeredAt: Date;
  lastHeartbeat: Date | null;
  capabilities: string[];
  process?: AgentProcess;
}

export class ProcessRegistry extends EventEmitter {
  private config: RegistryConfig;
  private agents: Map<string, AgentRegistration> = new Map();
  private heartbeatCheckTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<RegistryConfig>) {
    super();
    this.config = {
      autostartDir: FINGER_PATHS.runtime.autostartDir,
      heartbeatTimeoutMs: 90000,  // 90s
      autoStartOnBoot: true,
      ...config,
    };
  }

  /**
   * 初始化注册表
   */
  async initialize(): Promise<void> {
    log.info('Initializing process registry');

    // 启动心跳检查
    this.startHeartbeatCheck();

    // 自动启动 autostart 目录中的 agents
    if (this.config.autoStartOnBoot) {
      await this.loadAutostartAgents();
    }
  }

  /**
   * 注册 Agent
   */
  async registerAgent(info: {
    agentId: string;
    agentName: string;
    pid: number;
    capabilities?: string[];
  }): Promise<AgentRegistration> {
    const existing = this.agents.get(info.agentId);

    if (existing && existing.status === 'running') {
      // 更新心跳
      existing.lastHeartbeat = new Date();
      log.debug(`Agent heartbeat updated: ${info.agentId}`);
      return existing;
    }

    const registration: AgentRegistration = {
      agentId: info.agentId,
      agentName: info.agentName,
      pid: info.pid,
      status: 'registered',
      registeredAt: new Date(),
      lastHeartbeat: new Date(),
      capabilities: info.capabilities || [],
    };

    this.agents.set(info.agentId, registration);
    log.info(`Agent registered: ${info.agentId} (PID: ${info.pid})`);
    this.emit('registered', registration);

    return registration;
  }

  /**
   * 注销 Agent
   */
  async unregisterAgent(agentId: string, reason?: string): Promise<boolean> {
    const registration = this.agents.get(agentId);
    if (!registration) return false;

    log.info(`Agent unregistered: ${agentId} (${reason || 'unknown'})`);
    this.emit('unregistered', registration, reason);

    this.agents.delete(agentId);
    return true;
  }

  /**
   * 更新心跳
   */
  updateHeartbeat(agentId: string): boolean {
    const registration = this.agents.get(agentId);
    if (!registration) return false;

    registration.lastHeartbeat = new Date();
    registration.status = 'running';

    // 通知对应的 AgentProcess
    if (registration.process) {
      registration.process.updateHeartbeat();
    }

    return true;
  }

  /**
   * 获取所有已注册的 Agents
   */
  getAgents(): AgentRegistration[] {
    return Array.from(this.agents.values());
  }

  /**
   * 获取单个 Agent 信息
   */
  getAgent(agentId: string): AgentRegistration | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 启动 Agent 进程
   */
  async startAgentProcess(config: AgentProcessConfig): Promise<AgentProcessInfo> {
    const existing = this.agents.get(config.agentId);
    if (existing?.process?.isRunning()) {
      throw new Error(`Agent ${config.agentId} already running`);
    }

    const agentProcess = new AgentProcess(config);

    // 监听进程事件
    agentProcess.on('started', (info) => {
      this.registerAgent({
        agentId: config.agentId,
        agentName: config.agentName,
        pid: info.pid,
        capabilities: [],
      });
    });

    agentProcess.on('exited', (info) => {
      const registration = this.agents.get(config.agentId);
      if (registration) {
        registration.status = info.status;
        this.emit('process-exited', registration, info);
      }
    });

    const info = await agentProcess.start();

    // 保存进程引用
    const registration = this.agents.get(config.agentId);
    if (registration) {
      registration.process = agentProcess;
    }

    return info;
  }

  /**
   * 停止 Agent 进程
   */
  async stopAgentProcess(agentId: string, signal?: NodeJS.Signals): Promise<boolean> {
    const registration = this.agents.get(agentId);
    if (!registration?.process) return false;

    await registration.process.stop(signal);
    return true;
  }

  /**
   * 加载 autostart 目录中的 agents
   */
  private async loadAutostartAgents(): Promise<void> {
    const autostartDir = this.config.autostartDir;

    if (!existsSync(autostartDir)) {
      log.info(`Autostart directory not found: ${autostartDir}`);
      return;
    }

    log.info(`Loading agents from autostart: ${autostartDir}`);

    try {
      const files = await readdir(autostartDir);
      const jsFiles = files.filter(f => f.endsWith('.js'));

      for (const file of jsFiles) {
        const filePath = join(autostartDir, file);
        const agentName = file.replace('.js', '');

        try {
          log.info(`Starting autostart agent: ${agentName}`);

          await this.startAgentProcess({
            agentId: agentName,
            agentName,
            entryScript: filePath,
          });

        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          log.error(`Failed to start agent ${agentName}: ${err.message}`);
        }
      }

      log.info(`Loaded ${jsFiles.length} agents from autostart`);

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error(`Failed to load autostart agents: ${err.message}`);
    }
  }

  /**
   * 启动心跳检查
   */
  private startHeartbeatCheck(): void {
    const checkInterval = 30000;  // 30s

    this.heartbeatCheckTimer = setInterval(() => {
      this.checkHeartbeats();
    }, checkInterval);
  }

  /**
   * 检查所有 Agent 心跳
   */
  private checkHeartbeats(): void {
    const now = Date.now();
    const timeout = this.config.heartbeatTimeoutMs;

    for (const [agentId, registration] of this.agents) {
      if (registration.status !== 'running') continue;

      const lastHb = registration.lastHeartbeat?.getTime() || 0;
      const elapsed = now - lastHb;

      if (elapsed > timeout) {
        log.warn(`Agent ${agentId} heartbeat timeout (${elapsed}ms), marking as stopped`);
        registration.status = 'stopped';
        this.emit('heartbeat-timeout', registration);
      }
    }
  }

  /**
   * 关闭注册表
   */
  async shutdown(): Promise<void> {
    log.info('Shutting down process registry');

    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }

    // 停止所有进程
    for (const [agentId, registration] of this.agents) {
      if (registration.process) {
        try {
          await registration.process.stop();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          log.error(`Failed to stop agent ${agentId}: ${err.message}`);
        }
      }
    }

    this.agents.clear();
    log.info('Process registry shutdown complete');
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalAgents: number;
    runningAgents: number;
    stoppedAgents: number;
    crashedAgents: number;
  } {
    const agents = Array.from(this.agents.values());
    return {
      totalAgents: agents.length,
      runningAgents: agents.filter(a => a.status === 'running').length,
      stoppedAgents: agents.filter(a => a.status === 'stopped').length,
      crashedAgents: agents.filter(a => a.status === 'crashed').length,
    };
  }
}

// 全局单例
export const processRegistry = new ProcessRegistry();
export default ProcessRegistry;
