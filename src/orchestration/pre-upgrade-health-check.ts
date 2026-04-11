/**
 * PreUpgradeHealthCheck - 升级前健康检查
 *
 * 职责：
 * 1. 检查 daemon 状态（healthy / pending dispatch）
 * 2. 检查 AI provider 连通性
 * 3. 检查磁盘空间
 * 4. 检查 session 健康
 * 5. 检查依赖模块状态
 * 6. 生成完整健康检查报告
 */

import { statfs } from 'node:fs/promises';
import { logger } from '../core/logger.js';
import { moduleLayers } from './module-layers.js';

const log = logger.module('PreUpgradeHealthCheck');

export interface HealthCheckResult {
  ok: boolean;
  checks: {
    daemon: { ok: boolean; status: string; detail?: string };
    provider: { ok: boolean; latency?: number; detail?: string };
    diskSpace: { ok: boolean; availableMB: number; requiredMB: number; detail?: string };
    sessions: { ok: boolean; orphanCount: number; detail?: string };
    dependencies: { ok: boolean; missing: string[]; detail?: string };
  };
  summary: string;
}

export class PreUpgradeHealthCheck {
  private readonly daemonUrl: string;
  private readonly minDiskSpaceMB: number;

  constructor(opts?: { daemonUrl?: string; minDiskSpaceMB?: number }) {
    this.daemonUrl = opts?.daemonUrl || 'http://127.0.0.1:9999';
    this.minDiskSpaceMB = opts?.minDiskSpaceMB || 500; // 500MB default
  }

  // ==================== 单项检查 ====================

  /**
   * 检查 daemon 状态
   */
  async checkDaemon(): Promise<{ ok: boolean; status: string; detail?: string }> {
    try {
      const response = await fetch(`${this.daemonUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { ok: false, status: 'unhealthy', detail: `HTTP ${response.status}` };
      }

      const data = await response.json() as any;
      const status = data.status || 'unknown';
      if (status === 'healthy') {
        return { ok: true, status };
      }
      return { ok: false, status, detail: data.detail };
    } catch (error: any) {
      return {
        ok: false,
        status: 'unreachable',
        detail: `Daemon not reachable: ${error.message}`,
      };
    }
  }

  /**
   * 检查 AI provider 连通性
   */
  async checkProvider(): Promise<{ ok: boolean; latency?: number; detail?: string }> {
    try {
      const start = Date.now();
      const response = await fetch(`${this.daemonUrl}/api/provider/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(10000),
      });

      const latency = Date.now() - start;

      if (!response.ok) {
        return {
          ok: false,
          latency,
          detail: `Provider check failed: HTTP ${response.status}`,
        };
      }

      const data = await response.json() as any;
      if (data.connected === true || data.status === 'connected') {
        return { ok: true, latency };
      }

      return {
        ok: false,
        latency,
        detail: data.detail || 'Provider not connected',
      };
    } catch (error: any) {
      return {
        ok: false,
        detail: `Provider check failed: ${error.message}`,
      };
    }
  }

  /**
   * 检查磁盘空间
   */
  async checkDiskSpace(): Promise<{ ok: boolean; availableMB: number; requiredMB: number; detail?: string }> {
    try {
      // Use df command to check available space
      const { execSync } = await import('node:child_process');
      const output = execSync('df -m ~/.finger 2>/dev/null || df -m /tmp', { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const availableMB = parseInt(parts[3], 10) || 0;

        if (availableMB < this.minDiskSpaceMB) {
          return {
            ok: false,
            availableMB,
            requiredMB: this.minDiskSpaceMB,
            detail: `Only ${availableMB}MB available, need ${this.minDiskSpaceMB}MB`,
          };
        }

        return { ok: true, availableMB, requiredMB: this.minDiskSpaceMB };
      }

      return {
        ok: false,
        availableMB: 0,
        requiredMB: this.minDiskSpaceMB,
        detail: 'Failed to parse df output',
      };
    } catch (error: any) {
      return {
        ok: false,
        availableMB: 0,
        requiredMB: this.minDiskSpaceMB,
        detail: `Disk check failed: ${error.message}`,
      };
    }
  }

  /**
   * 检查 session 健康
   */
  async checkSessions(): Promise<{ ok: boolean; orphanCount: number; detail?: string }> {
    try {
      const response = await fetch(`${this.daemonUrl}/api/sessions/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          ok: false,
          orphanCount: -1,
          detail: `Session health check failed: HTTP ${response.status}`,
        };
      }

      const data = await response.json() as any;
      const orphanCount = data.orphanCount || 0;

      if (orphanCount > 10) {
        return {
          ok: false,
          orphanCount,
          detail: `Too many orphan sessions: ${orphanCount}`,
        };
      }

      return { ok: true, orphanCount };
    } catch (error: any) {
      // If daemon is not reachable, skip session check (it's covered by daemon check)
      return { ok: true, orphanCount: 0, detail: 'Session check skipped (daemon unreachable)' };
    }
  }

  /**
   * 检查依赖模块状态
   */
  async checkDependencies(moduleId: string): Promise<{ ok: boolean; missing: string[]; detail?: string }> {
    try {
      const deps = moduleLayers.getDependencies(moduleId);

      if (deps.length === 0) {
        return { ok: true, missing: [] };
      }

      const missing: string[] = [];

      for (const dep of deps) {
        const response = await fetch(`${this.daemonUrl}/api/modules/${dep}/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
          missing.push(dep);
          continue;
        }

        const data = await response.json() as any;
        if (data.status !== 'healthy' && data.status !== 'active') {
          missing.push(dep);
        }
      }

      return {
        ok: missing.length === 0,
        missing,
        detail: missing.length > 0 ? `Missing dependencies: ${missing.join(', ')}` : undefined,
      };
    } catch (error: any) {
      return {
        ok: false,
        missing: [],
        detail: `Dependency check failed: ${error.message}`,
      };
    }
  }

  // ==================== 完整健康检查 ====================

  /**
   * 运行完整健康检查
   */
  async runFullCheck(moduleId: string): Promise<HealthCheckResult> {
    log.info('Starting pre-upgrade health check', { moduleId });

    const [daemon, provider, diskSpace, sessions, dependencies] = await Promise.allSettled([
      this.checkDaemon(),
      this.checkProvider(),
      this.checkDiskSpace(),
      this.checkSessions(),
      this.checkDependencies(moduleId),
    ]);

    const extractResult = <T extends { ok: boolean }>(
      result: PromiseSettledResult<T>,
      fallback: T,
    ): T => {
      if (result.status === 'fulfilled') return result.value;
      log.warn('Health check failed unexpectedly', { check: result.reason });
      return { ...fallback, ok: false };
    };

    const checks = {
      daemon: extractResult(daemon, { ok: false, status: 'check_failed' }),
      provider: extractResult(provider, { ok: false }),
      diskSpace: extractResult(diskSpace, {
        ok: false,
        availableMB: 0,
        requiredMB: this.minDiskSpaceMB,
      }),
      sessions: extractResult(sessions, { ok: false, orphanCount: -1 }),
      dependencies: extractResult(dependencies, { ok: false, missing: [] }),
    };

    const allOk = Object.values(checks).every((c) => c.ok);

    const failed = Object.entries(checks)
      .filter(([_, v]) => !v.ok)
      .map(([k]) => k);

    const summary = allOk
      ? `All health checks passed for ${moduleId}`
      : `Health check failed: ${failed.join(', ')} not ok`;

    if (allOk) {
      log.info('Pre-upgrade health check passed', { moduleId });
    } else {
      log.warn('Pre-upgrade health check failed', { moduleId, failed });
    }

    return { ok: allOk, checks, summary };
  }
}
