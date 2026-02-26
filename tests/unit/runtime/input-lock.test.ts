import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InputLockManager } from '../../../src/runtime/input-lock.js';
import { globalEventBus } from '../../../src/runtime/event-bus.js';

describe('InputLockManager', () => {
  let lockManager: InputLockManager;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    lockManager = new InputLockManager(1000);
    emitSpy = vi.spyOn(globalEventBus, 'emit').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
    emitSpy.mockRestore();
  });

  describe('acquire', () => {
    it('should successfully acquire lock when no lock exists', () => {
      const result = lockManager.acquire('session-1', 'client-A');
      expect(result).toBe(true);
      expect(lockManager.isLocked('session-1')).toBe(true);
    });

    it('should allow same client to re-acquire lock', () => {
      lockManager.acquire('session-1', 'client-A');
      const result = lockManager.acquire('session-1', 'client-A');
      expect(result).toBe(true);
    });

    it('should reject different client when lock is held', () => {
      lockManager.acquire('session-1', 'client-A');
      const result = lockManager.acquire('session-1', 'client-B');
      expect(result).toBe(false);
      expect(lockManager.getState('session-1').lockedBy).toBe('client-A');
    });

    it('should emit input_lock_changed event on acquire', () => {
      lockManager.acquire('session-1', 'client-A');
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'input_lock_changed',
          sessionId: 'session-1',
          payload: expect.objectContaining({
            sessionId: 'session-1',
            lockedBy: 'client-A',
            typing: true,
            lastHeartbeatAt: expect.any(String),
            expiresAt: expect.any(String),
          }),
        })
      );
    });
  });

  describe('heartbeat', () => {
    it('should refresh lease for lock holder', () => {
      lockManager.acquire('session-1', 'client-A');
      const before = lockManager.getState('session-1');
      expect(before.expiresAt).toBeTruthy();

      vi.advanceTimersByTime(500);
      const ok = lockManager.heartbeat('session-1', 'client-A');
      expect(ok).toBe(true);

      const after = lockManager.getState('session-1');
      expect(after.expiresAt).toBeTruthy();
      expect(Date.parse(after.expiresAt!)).toBeGreaterThan(Date.parse(before.expiresAt!));
    });

    it('should reject heartbeat from non-owner', () => {
      lockManager.acquire('session-1', 'client-A');
      const ok = lockManager.heartbeat('session-1', 'client-B');
      expect(ok).toBe(false);
    });
  });

  describe('release', () => {
    it('should release lock when held by same client', () => {
      lockManager.acquire('session-1', 'client-A');
      lockManager.release('session-1', 'client-A');
      expect(lockManager.isLocked('session-1')).toBe(false);
    });

    it('should not release lock when held by different client', () => {
      lockManager.acquire('session-1', 'client-A');
      lockManager.release('session-1', 'client-B');
      expect(lockManager.isLocked('session-1')).toBe(true);
    });

    it('should emit input_lock_changed event on release', () => {
      lockManager.acquire('session-1', 'client-A');
      emitSpy.mockClear();
      lockManager.release('session-1', 'client-A');
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'input_lock_changed',
          sessionId: 'session-1',
          payload: expect.objectContaining({
            lockedBy: null,
          }),
        })
      );
    });
  });

  describe('forceRelease', () => {
    it('should release all locks for a specific client', () => {
      lockManager.acquire('session-1', 'client-A');
      lockManager.acquire('session-2', 'client-A');
      lockManager.acquire('session-3', 'client-B');

      lockManager.forceRelease('client-A');

      expect(lockManager.isLocked('session-1')).toBe(false);
      expect(lockManager.isLocked('session-2')).toBe(false);
      expect(lockManager.isLocked('session-3')).toBe(true);
    });
  });

  describe('setTyping', () => {
    it('should update typing state for lock holder', () => {
      lockManager.acquire('session-1', 'client-A');
      emitSpy.mockClear();

      lockManager.setTyping('session-1', 'client-A', false);

      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'typing_indicator',
          sessionId: 'session-1',
          payload: { clientId: 'client-A', typing: false },
        })
      );
    });

    it('should not update typing state for non-lock-holder', () => {
      lockManager.acquire('session-1', 'client-A');
      emitSpy.mockClear();

      lockManager.setTyping('session-1', 'client-B', true);

      expect(emitSpy).not.toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('should return lock state when lock exists', () => {
      lockManager.acquire('session-1', 'client-A');
      const state = lockManager.getState('session-1');
      expect(state).toEqual(
        expect.objectContaining({
          sessionId: 'session-1',
          lockedBy: 'client-A',
          typing: true,
        })
      );
    });

    it('should return unlocked state when no lock exists', () => {
      const state = lockManager.getState('session-1');
      expect(state).toEqual({
        sessionId: 'session-1',
        lockedBy: null,
        lockedAt: null,
        typing: false,
        lastHeartbeatAt: null,
        expiresAt: null,
      });
    });
  });

  describe('expiry', () => {
    it('should auto-release lock when lease expires without heartbeat', () => {
      lockManager.acquire('session-1', 'client-A');
      expect(lockManager.isLocked('session-1')).toBe(true);

      vi.advanceTimersByTime(1100);
      expect(lockManager.isLocked('session-1')).toBe(false);
    });
  });

  describe('isLocked', () => {
    it('should return false when no lock exists', () => {
      expect(lockManager.isLocked('session-1')).toBe(false);
    });

    it('should return true when lock is held', () => {
      lockManager.acquire('session-1', 'client-A');
      expect(lockManager.isLocked('session-1')).toBe(true);
    });

    it('should return false when excludeClientId matches lock holder', () => {
      lockManager.acquire('session-1', 'client-A');
      expect(lockManager.isLocked('session-1', 'client-A')).toBe(false);
    });
  });

  describe('getAllLocks', () => {
    it('should return all active locks', () => {
      lockManager.acquire('session-1', 'client-A');
      lockManager.acquire('session-2', 'client-B');

      const locks = lockManager.getAllLocks();
      expect(locks).toHaveLength(2);
      expect(locks.map((l) => l.sessionId)).toContain('session-1');
      expect(locks.map((l) => l.sessionId)).toContain('session-2');
    });

    it('should return empty array when no locks exist', () => {
      expect(lockManager.getAllLocks()).toHaveLength(0);
    });
  });
});
