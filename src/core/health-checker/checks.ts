/**
 * System Resource Checks
 */

import * as os from 'os';
import { FINGER_PATHS } from '../finger-paths.js';
import { logger } from '../logger.js';
import { HEALTH_CHECK_CONFIG } from './config.js';
import type { HealthCheckResult, SystemResourceStatus } from './types.js';

const log = logger.module('HealthChecker');

/**
 * 检查磁盘空间
 */
export function checkDiskSpace(): HealthCheckResult {
  try {
    const { used, free, total, usagePercent } = calculateDiskUsage(FINGER_PATHS.home);

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    let message = `Disk usage: ${usagePercent.toFixed(1)}%`;

    if (usagePercent >= HEALTH_CHECK_CONFIG.diskUsageCriticalThreshold) {
      status = 'critical';
      message = `Disk usage critical: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.diskUsageCriticalThreshold}%)`;
    } else if (usagePercent >= HEALTH_CHECK_CONFIG.diskUsageWarningThreshold) {
      status = 'warning';
      message = `Disk usage warning: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.diskUsageWarningThreshold}%)`;
    }

    return {
      name: 'disk_space',
      status,
      message,
      details: {
        used,
        free,
        total,
        usagePercent,
        path: FINGER_PATHS.home,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to check disk space', error);
    return {
      name: 'disk_space',
      status: 'critical',
      message: `Failed to check disk space: ${error.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 计算磁盘使用情况
 */
function calculateDiskUsage(dirPath: string): { used: number; free: number; total: number; usagePercent: number } {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const { execSync } = require('child_process');
    try {
      const output = execSync(`df -h ${dirPath}`).toString();
      const lines = output.split('\n');
      const values = lines[1].split(/\s+/);
      const total = parseDiskSize(values[1]);
      const used = parseDiskSize(values[2]);
      const available = parseDiskSize(values[3]);
      const free = available;
      const usagePercent = (used / total) * 100;
      return { used, free, total, usagePercent };
    } catch (err) {
      log.warn('Failed to get disk usage from df command', { error: String(err) });
    }
  }

  return { used: 0, free: 0, total: 0, usagePercent: 0 };
}

/**
 * 解析磁盘大小字符串（如 "100G", "500M"）
 */
function parseDiskSize(str: string): number {
  const match = str.match(/^(\d+(?:\.\d+)?)(K|M|G|T)?$/i);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toUpperCase();

  const multipliers: Record<string, number> = {
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
  };

  return value * (multipliers[unit] || 1);
}

/**
 * 检查内存使用情况
 */
export function checkMemoryUsage(): HealthCheckResult {
  try {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usagePercent = (used / total) * 100;

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    let message = `Memory usage: ${usagePercent.toFixed(1)}%`;

    if (usagePercent >= HEALTH_CHECK_CONFIG.memoryUsageCriticalThreshold) {
      status = 'critical';
      message = `Memory usage critical: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.memoryUsageCriticalThreshold}%)`;
    } else if (usagePercent >= HEALTH_CHECK_CONFIG.memoryUsageWarningThreshold) {
      status = 'warning';
      message = `Memory usage warning: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.memoryUsageWarningThreshold}%)`;
    }

    return {
      name: 'memory_usage',
      status,
      message,
      details: {
        total,
        used,
        free,
        usagePercent,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to check memory usage', error);
    return {
      name: 'memory_usage',
      status: 'critical',
      message: `Failed to check memory usage: ${error.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 检查CPU使用情况
 */
export function checkCPUUsage(): HealthCheckResult {
  try {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const usagePercent = 100 - (totalIdle / totalTick) * 100;

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    let message = `CPU usage: ${usagePercent.toFixed(1)}%`;

    if (usagePercent >= HEALTH_CHECK_CONFIG.cpuUsageCriticalThreshold) {
      status = 'critical';
      message = `CPU usage critical: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.cpuUsageCriticalThreshold}%)`;
    } else if (usagePercent >= HEALTH_CHECK_CONFIG.cpuUsageWarningThreshold) {
      status = 'warning';
      message = `CPU usage warning: ${usagePercent.toFixed(1)}% (>= ${HEALTH_CHECK_CONFIG.cpuUsageWarningThreshold}%)`;
    }

    return {
      name: 'cpu_usage',
      status,
      message,
      details: {
        usagePercent,
        cpuCount: cpus.length,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to check CPU usage', error);
    return {
      name: 'cpu_usage',
      status: 'critical',
      message: `Failed to check CPU usage: ${error.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * 运行所有健康检查
 */
export function runAllHealthChecks(): HealthCheckResult[] {
  return [
    checkDiskSpace(),
    checkMemoryUsage(),
    checkCPUUsage(),
    checkBdCliAvailable(),
  ];
}

/**
 * 获取系统资源状态
 */
export function getSystemResourceStatus(): SystemResourceStatus {
  const diskResult = checkDiskSpace();
  const memoryResult = checkMemoryUsage();
  const cpuResult = checkCPUUsage();
  const cpuUsage = typeof cpuResult.details?.usagePercent === 'number'
    ? cpuResult.details.usagePercent
    : 0;

  return {
    diskSpace: (diskResult.details || { used: 0, free: 0, total: 0, usagePercent: 0, path: '' }) as { used: number; free: number; total: number; usagePercent: number; path: string },
    memory: (memoryResult.details || { total: 0, used: 0, free: 0, usagePercent: 0 }) as { total: number; used: number; free: number; usagePercent: number },
    cpu: { usagePercent: cpuUsage },
    uptime: os.uptime(),
  };
}

/**
 * 检查 bd CLI 工具是否可用
 */
export function checkBdCliAvailable(): HealthCheckResult {
  try {
    const { execSync } = require('child_process');
    const result = execSync('which bd', { encoding: 'utf8', timeout: 5000 }).trim();
    const bdPath = result || '';
    
    if (!bdPath) {
      return {
        name: 'bd_cli',
        status: 'critical',
        message: 'bd CLI not found in PATH. Task management unavailable.',
        details: { bdPath: '' },
        timestamp: new Date().toISOString(),
      };
    }
    
    const versionResult = execSync('bd --version', { encoding: 'utf8', timeout: 5000 }).trim();
    const versionMatch = versionResult.match(/bd version ([\d.]+)/);
    const version = versionMatch ? versionMatch[1] : 'unknown';
    
    return {
      name: 'bd_cli',
      status: 'healthy',
      message: `bd CLI available: ${bdPath} (v${version})`,
      details: { bdPath, version },
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error('Failed to check bd CLI', error);
    return {
      name: 'bd_cli',
      status: 'critical',
      message: `bd CLI check failed: ${error.message}`,
      timestamp: new Date().toISOString(),
    };
  }
}
