import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import logger from '../shared/logger.js';

export interface ManagedProcess {
  id: string;
  process: ChildProcess;
  type: 'iflow-cli' | 'browser' | 'other';
  startTime: Date;
  lastActivity: Date;
  metadata?: Record<string, unknown>;
}

export interface ResourceLimits {
  maxProcessesPerAgent: number;
  maxTotalProcesses: number;
  processTimeoutMs: number;
  idleTimeoutMs: number;
}

const DEFAULT_LIMITS: ResourceLimits = {
  maxProcessesPerAgent: 3,
  maxTotalProcesses: 20,
  processTimeoutMs: 5 * 60 * 1000, // 5 minutes
  idleTimeoutMs: 2 * 60 * 1000, // 2 minutes
};

class AgentLifecycleManager extends EventEmitter {
  private processes = new Map<string, ManagedProcess>();
  private limits: ResourceLimits;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(limits: Partial<ResourceLimits> = {}) {
    super();
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.startCleanupTimer();
  }

  registerProcess(
    id: string,
    process: ChildProcess,
    type: ManagedProcess['type'],
    metadata?: Record<string, unknown>
  ): void {
    // Kill existing process with same ID
    this.killProcess(id, 'replaced');

    // Check limits
    const sameType = Array.from(this.processes.values()).filter(p => p.type === type);
    if (sameType.length >= this.limits.maxProcessesPerAgent) {
      // Kill oldest idle process
      const oldest = sameType.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime())[0];
      if (oldest) {
        this.killProcess(oldest.id, 'limit-exceeded');
      }
    }

    if (this.processes.size >= this.limits.maxTotalProcesses) {
      const oldest = Array.from(this.processes.values())
        .sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime())[0];
      if (oldest) {
        this.killProcess(oldest.id, 'global-limit-exceeded');
      }
    }

    this.processes.set(id, {
      id,
      process,
      type,
      startTime: new Date(),
      lastActivity: new Date(),
      metadata,
    });

    process.on('exit', (code) => {
      this.processes.delete(id);
      this.emit('process-exit', { id, type, code });
    });

    logger.debug(`Registered ${type} process: ${id}`);
  }

  killProcess(id: string, reason: string): boolean {
    const managed = this.processes.get(id);
    if (!managed) return false;

    const { process } = managed;

    // Try graceful kill first
    process.kill('SIGTERM');

    // Force kill after timeout
    setTimeout(() => {
      if (!process.killed) {
        process.kill('SIGKILL');
        logger.warn(`Force killed process ${id} after SIGTERM timeout`);
      }
    }, 5000);

    this.processes.delete(id);
    this.emit('process-killed', { id, type: managed.type, reason });
    logger.info(`Killed ${managed.type} process ${id}: ${reason}`);

    return true;
  }

  killAllByType(type: ManagedProcess['type']): number {
    let count = 0;
    for (const [id, proc] of this.processes) {
      if (proc.type === type) {
        this.killProcess(id, 'bulk-cleanup');
        count++;
      }
    }
    return count;
  }

  updateActivity(id: string): void {
    const managed = this.processes.get(id);
    if (managed) {
      managed.lastActivity = new Date();
    }
  }

  getActiveProcesses(type?: ManagedProcess['type']): ManagedProcess[] {
    const all = Array.from(this.processes.values());
    return type ? all.filter(p => p.type === type) : all;
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, proc] of this.processes) {
        const idleTime = now - proc.lastActivity.getTime();
        if (idleTime > this.limits.idleTimeoutMs) {
          this.killProcess(id, 'idle-timeout');
        }
      }
    }, 30000); // Check every 30s
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    for (const id of this.processes.keys()) {
      this.killProcess(id, 'disposed');
    }
    this.processes.clear();
  }
}

export const lifecycleManager = new AgentLifecycleManager();

import fs from 'fs';
import path from 'path';
import os from 'os';
import { HeartbeatBroker, HeartbeatMonitor } from './heartbeat-broker.js';

// Extended lifecycle manager with orphan cleanup
export function cleanupOrphanProcesses(): { killed: string[]; errors: string[] } {
  const killed: string[] = [];
  const errors: string[] = [];

  const fingerHome = path.join(os.homedir(), '.finger');
  const agentsDir = path.join(fingerHome, 'agents');

  if (!fs.existsSync(agentsDir)) {
    return { killed, errors };
  }

  const pidFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.pid'));

  for (const pidFile of pidFiles) {
    const agentId = pidFile.replace('.pid', '');
    const filePath = path.join(agentsDir, pidFile);

    try {
      const pid = parseInt(fs.readFileSync(filePath, 'utf-8').trim(), 10);

      if (!Number.isFinite(pid)) {
        fs.unlinkSync(filePath);
        continue;
      }

      try {
        process.kill(pid, 0);
        console.log(`[LifecycleManager] Killing orphan process ${agentId} (PID ${pid})`);
        process.kill(pid, 'SIGTERM');
        setTimeout(() => {
          try {
            process.kill(pid, 0);
            process.kill(pid, 'SIGKILL');
          } catch { /* Already dead */ }
        }, 5000);
        killed.push(agentId);
      } catch {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      errors.push(`${agentId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const daemonPidFile = path.join(fingerHome, 'daemon.pid');
  if (fs.existsSync(daemonPidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(daemonPidFile, 'utf-8').trim(), 10);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0);
        } catch {
          fs.unlinkSync(daemonPidFile);
        }
      }
    } catch { /* Ignore */ }
  }

  return { killed, errors };
}

export { HeartbeatBroker, HeartbeatMonitor };
