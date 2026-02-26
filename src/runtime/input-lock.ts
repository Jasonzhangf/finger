/**
 * InputLockManager - 跨端输入锁管理器
 * 
 * 职责：
 * 1. 管理多端输入互斥锁
 * 2. 广播锁状态变化
 * 3. 支持正在输入指示器
 * 
 * 使用：
 * - 服务端：在消息发送前调用 acquire()，发送后调用 release()
 * - UI 端：订阅 INPUT_LOCK 事件分组，响应锁状态变化
 */

import { globalEventBus } from './event-bus.js';

export interface InputLockState {
  sessionId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  typing: boolean;
  lastHeartbeatAt: string | null;
  expiresAt: string | null;
}

export interface InputLockChangedEvent {
  type: 'input_lock_changed';
  sessionId: string;
  timestamp: string;
  payload: InputLockState;
}

export interface TypingIndicatorEvent {
  type: 'typing_indicator';
  sessionId: string;
  timestamp: string;
  payload: {
    clientId: string;
    typing: boolean;
  };
}

export type InputLockEvent = InputLockChangedEvent | TypingIndicatorEvent;

/** 锁超时时间（毫秒），防止客户端断连后锁未释放 */
const LOCK_TIMEOUT_MS = 30000;

export class InputLockManager {
  private locks = new Map<string, InputLockState>();
  private timeoutHandles = new Map<string, NodeJS.Timeout>();

  constructor(private readonly lockTimeoutMs: number = LOCK_TIMEOUT_MS) {}

  /**
   * 尝试获取输入锁
   * @returns true 表示成功获取，false 表示被其他端占用
   */
  acquire(sessionId: string, clientId: string): boolean {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);

    if (current?.lockedBy && current.lockedBy !== clientId) {
      return false;
    }

    const now = new Date();
    const heartbeatAt = now.toISOString();
    const lockedAt = current?.lockedBy === clientId && current.lockedAt ? current.lockedAt : heartbeatAt;

    const state: InputLockState = {
      sessionId,
      lockedBy: clientId,
      lockedAt,
      typing: true,
      lastHeartbeatAt: heartbeatAt,
      expiresAt: new Date(now.getTime() + this.lockTimeoutMs).toISOString(),
    };

    this.locks.set(sessionId, state);
    this.broadcastLockChange(sessionId);
    this.setTimeout(sessionId, clientId);

    return true;
  }

  /**
   * 锁持有方心跳续租
   * @returns true 表示续租成功；false 表示当前客户端并非持有方
   */
  heartbeat(sessionId: string, clientId: string): boolean {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);
    if (!current || current.lockedBy !== clientId) {
      return false;
    }

    const now = new Date();
    current.lastHeartbeatAt = now.toISOString();
    current.expiresAt = new Date(now.getTime() + this.lockTimeoutMs).toISOString();
    this.setTimeout(sessionId, clientId);
    return true;
  }

  /**
   * 释放输入锁
   */
  release(sessionId: string, clientId: string): void {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);

    if (current?.lockedBy === clientId) {
      this.clearTimeout(sessionId);
      this.locks.delete(sessionId);
      this.broadcastLockChange(sessionId);
    }
  }

  /**
   * 强制释放锁（用于客户端断连）
   */
  forceRelease(clientId: string): void {
    for (const [sessionId, state] of this.locks) {
      if (state.lockedBy === clientId) {
        this.clearTimeout(sessionId);
        this.locks.delete(sessionId);
        this.broadcastLockChange(sessionId);
      }
    }
  }

  /**
   * 更新正在输入状态
   */
  setTyping(sessionId: string, clientId: string, typing: boolean): void {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);

    if (current?.lockedBy === clientId) {
      current.typing = typing;
      this.heartbeat(sessionId, clientId);
      globalEventBus.emit({
        type: 'typing_indicator',
        sessionId,
        timestamp: new Date().toISOString(),
        payload: { clientId, typing },
      });
    }
  }

  /**
   * 查询锁状态
   */
  getState(sessionId: string): InputLockState {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);
    return current ? this.cloneState(current) : {
      sessionId,
      lockedBy: null,
      lockedAt: null,
      typing: false,
      lastHeartbeatAt: null,
      expiresAt: null,
    };
  }

  /**
   * 检查锁是否被占用
   */
  isLocked(sessionId: string, excludeClientId?: string): boolean {
    this.evictIfExpired(sessionId);
    const current = this.locks.get(sessionId);
    if (!current?.lockedBy) return false;
    if (excludeClientId && current.lockedBy === excludeClientId) return false;
    return true;
  }

  /**
   * 获取所有锁状态
   */
  getAllLocks(): InputLockState[] {
    for (const sessionId of this.locks.keys()) {
      this.evictIfExpired(sessionId);
    }
    return Array.from(this.locks.values(), (state) => this.cloneState(state));
  }

  private broadcastLockChange(sessionId: string): void {
    const state = this.locks.get(sessionId);
    
    globalEventBus.emit({
      type: 'input_lock_changed',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: state
        ? this.cloneState(state)
        : {
        sessionId,
        lockedBy: null,
        lockedAt: null,
        typing: false,
        lastHeartbeatAt: null,
        expiresAt: null,
        },
    });
  }

  private setTimeout(sessionId: string, clientId: string): void {
    this.clearTimeout(sessionId);
    const handle = setTimeout(() => {
      const current = this.locks.get(sessionId);
      if (!current || current.lockedBy !== clientId) return;
      this.locks.delete(sessionId);
      this.broadcastLockChange(sessionId);
    }, this.lockTimeoutMs);

    this.timeoutHandles.set(sessionId, handle);
  }

  private clearTimeout(sessionId: string): void {
    const handle = this.timeoutHandles.get(sessionId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(sessionId);
    }
  }

  private evictIfExpired(sessionId: string): void {
    const current = this.locks.get(sessionId);
    if (!current || !current.expiresAt) return;
    const expiresAt = Date.parse(current.expiresAt);
    if (!Number.isFinite(expiresAt) || Date.now() < expiresAt) return;
    this.clearTimeout(sessionId);
    this.locks.delete(sessionId);
    this.broadcastLockChange(sessionId);
  }

  private cloneState(state: InputLockState): InputLockState {
    return {
      sessionId: state.sessionId,
      lockedBy: state.lockedBy,
      lockedAt: state.lockedAt,
      typing: state.typing,
      lastHeartbeatAt: state.lastHeartbeatAt,
      expiresAt: state.expiresAt,
    };
  }
}

export const inputLockManager = new InputLockManager();
