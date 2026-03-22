/**
 * Startup and Periodic Health Checks
 */

import { logger } from '../logger.js';
import { runAllHealthChecks } from './checks.js';
import { performResourceCleanup } from './cleanup.js';
import { performAutoRecovery } from './recovery.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Startup');

const log = logger.module('HealthChecker');

/**
 * 执行启动时健康检查
 */
export function performStartupHealthCheck(): boolean {
  log.info('Performing startup health check');

  const results = runAllHealthChecks();
  const criticalResults = results.filter(r => r.status === 'critical');
  const warningResults = results.filter(r => r.status === 'warning');

  if (criticalResults.length > 0) {
    log.error('Startup health check failed - critical issues found', new Error(JSON.stringify(criticalResults)));
    for (const result of criticalResults) {
      clog.error(`❌ [Health Check] ${result.message}`);
    }
    performAutoRecovery(results);
    return false;
  }

  if (warningResults.length > 0) {
    log.warn('Startup health check passed with warnings', { warningResults });
    for (const result of warningResults) {
      clog.warn(`⚠️ [Health Check] ${result.message}`);
    }
  } else {
    log.info('Startup health check passed');
    log.info('✓ [Health Check] All systems healthy');
  }

  return true;
}

/**
 * 执行定期健康检查
 */
export function performPeriodicHealthCheck(): void {
  log.info('Performing periodic health check');

  const results = runAllHealthChecks();
  const criticalResults = results.filter(r => r.status === 'critical');
  const warningResults = results.filter(r => r.status === 'warning');

  if (criticalResults.length > 0) {
    log.error('Periodic health check failed - critical issues found', new Error(JSON.stringify(criticalResults)));
    performAutoRecovery(results);
  } else if (warningResults.length > 0) {
    log.warn('Periodic health check passed with warnings', { warningResults });
  } else {
    log.info('Periodic health check passed');
  }
}

/**
 * 执行资源自动清理
 */
export function performAutoCleanup(): void {
  log.info('Performing auto cleanup');

  const stats = performResourceCleanup();

  if (stats.sessionsRemoved > 0 || stats.logsRemoved > 0 || stats.backupsRemoved > 0) {
    log.info('Auto cleanup completed', { stats });
    clog.log(`[Health Check] Cleaned up: ${stats.sessionsRemoved} sessions, ${stats.logsRemoved} logs, ${stats.backupsRemoved} backups`);
  } else {
    log.info('No resources to clean up');
  }
}
