/**
 * HeartbeatServer - Daemon 向所有注册模块发送心跳
 * 
 * 机制:
 * 1. Daemon 定期向所有注册的模块发送心跳
 * 2. 模块收到心跳后回复确认
 * 3. 模块连续 N 次未收到心跳则自杀
 */

import { EventEmitter } from 'events';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatServer');

export interface HeartbeatTarget {
  id: string;
  type: 'input' | 'output' | 'agent';
  lastResponse?: Date;
  consecutiveMisses: number;
}

export interface HeartbeatServerConfig {
  intervalMs: number;
  maxMisses: number;
}

export class HeartbeatServer extends EventEmitter {
  private config: HeartbeatServerConfig;
  private targets: Map<string, HeartbeatTarget> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config?: Partial<HeartbeatServerConfig>) {
    super();
    this.config = {
      intervalMs: 30000,
      maxMisses: 3,
      ...config,
    };
  }

  registerTarget(id: string, type: 'input' | 'output' | 'agent'): void {
    this.targets.set(id, { id, type, consecutiveMisses: 0 });
    log.info(`Registered heartbeat target: ${id} (${type})`);
  }

  unregisterTarget(id: string): void {
    this.targets.delete(id);
    log.info(`Unregistered heartbeat target: ${id}`);
  }

  recordResponse(id: string): void {
    const target = this.targets.get(id);
    if (target) {
      target.lastResponse = new Date();
      target.consecutiveMisses = 0;
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(() => {
      this.sendHeartbeats();
    }, this.config.intervalMs);

    this.sendHeartbeats();
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sendHeartbeats(): Promise<void> {
    const timestamp = Date.now();

    for (const [id, target] of this.targets) {
      this.emit('heartbeat', {
        targetId: id,
        targetType: target.type,
        timestamp,
      });

      target.consecutiveMisses++;
      
      if (target.consecutiveMisses >= this.config.maxMisses) {
        log.error(`Target ${id} missed ${target.consecutiveMisses} heartbeats`);
        this.emit('target-dead', target);
        this.unregisterTarget(id);
      }
    }
  }

  getTargetsStatus(): Array<{ id: string; type: string; consecutiveMisses: number; lastResponse?: Date }> {
    return Array.from(this.targets.values());
  }
}

export const heartbeatServer = new HeartbeatServer();
export default HeartbeatServer;
