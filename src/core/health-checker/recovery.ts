/**
 * Auto Recovery Logic
 */

import { logger } from '../logger.js';
import type { HealthCheckResult } from './types.js';
import { performResourceCleanup } from './cleanup.js';

const log = logger.module('HealthChecker');

/**
 * 执行异常检测与自动恢复
 */
export function performAutoRecovery(results: HealthCheckResult[]): boolean {
  const criticalResults = results.filter(r => r.status === 'critical');

  if (criticalResults.length === 0) {
    return true;
  }

  log.warn('Auto recovery triggered due to critical health checks', { criticalResults });

  // 当前自动恢复策略：执行资源清理
  const stats = performResourceCleanup();
  log.info('Auto recovery cleanup executed', { stats });

  return false;
}
