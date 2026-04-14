/**
 * Context History Lock - Session 级互斥锁
 * 
 * 防止同一 session 同时执行多个 rebuild
 */

import { DEFAULT_CONFIG } from './types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryLock');

/**
 * Session 锁状态
 */
const sessionLocks = new Map<string, {
  holder: 'rebuild' | 'read';
  acquiredAt: number;
  timeoutMs: number;
}>();

/**
 * 获取 session 锁
 */
export async function acquireSessionLock(
  sessionId: string,
  holder: 'rebuild' | 'read'
): Promise<void> {
  const timeoutMs = DEFAULT_CONFIG.lockTimeoutMs;
  const startTime = Date.now();
  
  while (true) {
    const existingLock = sessionLocks.get(sessionId);
    
    if (!existingLock) {
      // 无锁，直接获取
      sessionLocks.set(sessionId, {
        holder,
        acquiredAt: Date.now(),
        timeoutMs,
      });
      log.debug('Lock acquired', { sessionId, holder });
      return;
    }
    
    // 检查是否超时
    const elapsed = Date.now() - existingLock.acquiredAt;
    if (elapsed > existingLock.timeoutMs) {
      // 超时，强制释放
      log.warn('Lock timeout, force release', {
        sessionId,
        oldHolder: existingLock.holder,
        elapsed,
      });
      sessionLocks.delete(sessionId);
      continue;
    }
    
    // 检查是否等待超时
    const waitElapsed = Date.now() - startTime;
    if (waitElapsed > timeoutMs) {
      // 等待超时，抛出错误
      throw new Error(`Lock acquisition timeout for session ${sessionId}`);
    }
    
    // 等待 100ms 后重试
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * 释放 session 锁
 */
export function releaseSessionLock(sessionId: string): void {
  const lock = sessionLocks.get(sessionId);
  if (lock) {
    sessionLocks.delete(sessionId);
    log.debug('Lock released', { sessionId, holder: lock.holder });
  }
}

/**
 * 检查 session 是否有锁
 */
export function hasSessionLock(sessionId: string): boolean {
  return sessionLocks.has(sessionId);
}

/**
 * 获取 session 锁状态
 */
export function getSessionLock(sessionId: string): { holder: string; acquiredAt: number } | null {
  const lock = sessionLocks.get(sessionId);
  if (!lock) return null;
  
  return {
    holder: lock.holder,
    acquiredAt: lock.acquiredAt,
  };
}

/**
 * 清理所有锁（用于测试或重启）
 */
export function clearAllLocks(): void {
  sessionLocks.clear();
  log.info('All locks cleared');
}
