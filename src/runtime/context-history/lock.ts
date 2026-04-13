/**
 * Context History Management - Session 级互斥锁
 */

import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryLock');

interface SessionLockState {
  sessionId: string;
  locked: boolean;
  lockType: 'rebuild' | 'compact' | 'mixed';
  acquiredAt: number;
  waitingQueue: Array<{
    type: 'rebuild' | 'compact' | 'mixed';
    resolve: () => void;
  }>;
}

class SessionLockManager {
  private locks: Map<string, SessionLockState> = new Map();

  async acquire(sessionId: string, lockType: 'rebuild' | 'compact' | 'mixed'): Promise<boolean> {
    const existing = this.locks.get(sessionId);

    if (!existing || !existing.locked) {
      this.locks.set(sessionId, {
        sessionId,
        locked: true,
        lockType,
        acquiredAt: Date.now(),
        waitingQueue: [],
      });
      log.debug('Lock acquired', { sessionId, lockType });
      return true;
    }

    log.debug('Lock waiting', { sessionId, lockType, existingType: existing.lockType });
    
    return new Promise<boolean>((resolve) => {
      existing.waitingQueue.push({
        type: lockType,
        resolve: () => resolve(true),
      });
    });
  }

  release(sessionId: string): void {
    const existing = this.locks.get(sessionId);

    if (!existing) {
      log.warn('Lock release without lock', { sessionId });
      return;
    }

    if (existing.waitingQueue.length > 0) {
      const next = existing.waitingQueue.shift();
      if (next) {
        existing.lockType = next.type;
        existing.acquiredAt = Date.now();
        log.debug('Lock transferred', { sessionId, newType: next.type });
        next.resolve();
      }
    } else {
      existing.locked = false;
      log.debug('Lock released', { sessionId });
    }
  }

  isLocked(sessionId: string): boolean {
    const existing = this.locks.get(sessionId);
    return existing?.locked ?? false;
  }

  cleanupStaleLocks(): void {
    const now = Date.now();
    const staleThreshold = 30 * 1000;

    for (const [sessionId, state] of this.locks.entries()) {
      if (state.locked && now - state.acquiredAt > staleThreshold) {
        log.warn('Stale lock cleaned', { sessionId, lockType: state.lockType });
        state.locked = false;
        state.waitingQueue.forEach((w) => w.resolve());
        state.waitingQueue = [];
      }
    }
  }
}

export const sessionLockManager = new SessionLockManager();

export async function acquireSessionLock(
  sessionId: string,
  lockType: 'rebuild' | 'compact' | 'mixed',
): Promise<boolean> {
  return sessionLockManager.acquire(sessionId, lockType);
}

export function releaseSessionLock(sessionId: string): void {
  sessionLockManager.release(sessionId);
}

export function isSessionLocked(sessionId: string): boolean {
  return sessionLockManager.isLocked(sessionId);
}
