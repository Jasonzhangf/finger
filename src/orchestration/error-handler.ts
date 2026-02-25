/**
 * Finger Error Handler System
 * 
 * 错误分类与处理策略：
 * - Recoverable: 指数回退重试（最多10次），最终失败后停止
 * - Unrecoverable: 立即停止，等待手动恢复
 */

import { logger } from '../core/logger.js';

export type ErrorCategory = 
  | 'network'        // 网络连接失败（可恢复）
  | 'timeout'        // 超时（可恢复）
  | 'rate_limit'     // 限流（可恢复）
  | 'auth_failed'    // 认证失败（不可恢复）
  | 'invalid_config' // 配置错误（不可恢复）
  | 'module_crash'   // 模块崩溃（不可恢复）
  | 'resource_exhausted' // 资源耗尽（可恢复）
  | 'unknown';       // 未知错误（保守处理为不可恢复）

export type ErrorSeverity = 'recoverable' | 'unrecoverable';

export interface FingerError extends Error {
  category: ErrorCategory;
  severity: ErrorSeverity;
  moduleId?: string;
  retryCount: number;
  maxRetries: number;
  isFinalFailure: boolean;
  nextRetryAt?: Date;
  originalError?: Error;
}

export interface RetryState {
  moduleId: string;
  retryCount: number;
  lastError?: FingerError;
  nextRetryAt?: Date;
  isPaused: boolean;
  pauseReason?: string;
  pausedAt?: Date;
}

export interface ErrorHandlerConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_CONFIG: ErrorHandlerConfig = {
  maxRetries: 10,
  baseDelayMs: 1000,      // 1s
  maxDelayMs: 60000,      // 60s
  backoffMultiplier: 2,
};

// 错误分类映射
const ERROR_SEVERITY_MAP: Record<ErrorCategory, ErrorSeverity> = {
  network: 'recoverable',
  timeout: 'recoverable',
  rate_limit: 'recoverable',
  auth_failed: 'unrecoverable',
  invalid_config: 'unrecoverable',
  module_crash: 'unrecoverable',
  resource_exhausted: 'recoverable',
  unknown: 'unrecoverable', // 保守处理
};

export class FingerErrorHandler {
  private config: ErrorHandlerConfig;
  private retryStates: Map<string, RetryState> = new Map();
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onRetryCallback?: (moduleId: string, error: FingerError) => Promise<void>;
  private log = logger.module('ErrorHandler');

  constructor(config: Partial<ErrorHandlerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 创建标准化的 FingerError
   */
  createError(
    category: ErrorCategory,
    message: string,
    moduleId?: string,
    originalError?: Error
  ): FingerError {
    const severity = ERROR_SEVERITY_MAP[category];
    const state = moduleId ? this.retryStates.get(moduleId) : undefined;
    const retryCount = state?.retryCount ?? 0;

    const error = new Error(message) as FingerError;
    error.name = `FingerError[${category}]`;
    error.category = category;
    error.severity = severity;
    error.moduleId = moduleId;
    error.retryCount = retryCount;
    error.maxRetries = this.config.maxRetries;
    error.isFinalFailure = severity === 'unrecoverable' || retryCount >= this.config.maxRetries;
    error.originalError = originalError;

    if (severity === 'recoverable' && !error.isFinalFailure) {
      error.nextRetryAt = this.calculateNextRetry(retryCount);
    }

    return error;
  }

  /**
   * 处理错误 - 核心入口
   */
  async handleError(
    error: Error | FingerError,
    moduleId: string,
    retryFn: () => Promise<void>
  ): Promise<{ handled: boolean; paused: boolean; reason?: string }> {
    // 标准化错误
    const fingerError = this.isFingerError(error) 
      ? error 
      : this.createError('unknown', error.message, moduleId, error);

    // 记录错误日志
    this.log.error(`Error in ${moduleId}`, fingerError, {
      category: fingerError.category,
      severity: fingerError.severity,
      retryCount: fingerError.retryCount,
    });

    // 更新状态
    this.updateRetryState(moduleId, fingerError);

    // 不可恢复错误：立即暂停
    if (fingerError.severity === 'unrecoverable') {
      await this.pauseModule(moduleId, `Unrecoverable error: ${fingerError.category}`);
      return { handled: true, paused: true, reason: fingerError.category };
    }

    // 可恢复错误：检查重试次数
    const state = this.retryStates.get(moduleId)!;
    
    if (state.retryCount >= this.config.maxRetries) {
      await this.pauseModule(moduleId, `Max retries (${this.config.maxRetries}) exceeded`);
      return { handled: true, paused: true, reason: 'max_retries_exceeded' };
    }

    // 安排重试
    this.scheduleRetry(moduleId, retryFn, fingerError);
    return { handled: true, paused: false };
  }

  /**
   * 手动恢复暂停的模块
   */
  async resumeModule(moduleId: string): Promise<boolean> {
    const state = this.retryStates.get(moduleId);
    if (!state || !state.isPaused) {
      return false;
    }

    state.isPaused = false;
    state.pauseReason = undefined;
    state.retryCount = 0; // 重置计数
    state.pausedAt = undefined;
    
    // 清除可能存在的定时器
    const timer = this.retryTimers.get(moduleId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(moduleId);
    }

    this.log.info(`Module ${moduleId} manually resumed`, { moduleId });
    return true;
  }

  /**
   * 获取模块状态
   */
  getModuleState(moduleId: string): RetryState | undefined {
    return this.retryStates.get(moduleId);
  }

  /**
   * 获取所有暂停的模块
   */
  getPausedModules(): RetryState[] {
    return Array.from(this.retryStates.values()).filter(s => s.isPaused);
  }

  /**
   * 获取所有重试状态
   */
  getAllStates(): RetryState[] {
    return Array.from(this.retryStates.values());
  }

  /**
   * 设置重试回调
   */
  onRetry(callback: (moduleId: string, error: FingerError) => Promise<void>): void {
    this.onRetryCallback = callback;
  }

  /**
   * 清理所有定时器
   */
  shutdown(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.log.info('ErrorHandler shutdown');
  }

  // ========== 私有方法 ==========

  private isFingerError(error: Error): error is FingerError {
    return 'category' in error && 'severity' in error;
  }

  private calculateNextRetry(retryCount: number): Date {
    // 指数回退: baseDelay * (multiplier ^ retryCount)
    const delay = Math.min(
      this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, retryCount),
      this.config.maxDelayMs
    );
    return new Date(Date.now() + delay);
  }

  private updateRetryState(moduleId: string, error: FingerError): void {
    const existing = this.retryStates.get(moduleId);
    
    if (existing && error.severity === 'recoverable') {
      existing.retryCount++;
      existing.lastError = error;
      existing.nextRetryAt = error.nextRetryAt;
    } else {
      this.retryStates.set(moduleId, {
        moduleId,
        retryCount: error.severity === 'recoverable' ? 1 : 0,
        lastError: error,
        nextRetryAt: error.nextRetryAt,
        isPaused: error.severity === 'unrecoverable',
        pauseReason: error.severity === 'unrecoverable' ? error.category : undefined,
        pausedAt: error.severity === 'unrecoverable' ? new Date() : undefined,
      });
    }
  }

  private async pauseModule(moduleId: string, reason: string): Promise<void> {
    const state = this.retryStates.get(moduleId);
    if (state) {
      state.isPaused = true;
      state.pauseReason = reason;
      state.pausedAt = new Date();
    }
    
    // 清除定时器
    const timer = this.retryTimers.get(moduleId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(moduleId);
    }

    this.log.warn(`Module ${moduleId} paused`, { moduleId, reason });
  }

  private scheduleRetry(
    moduleId: string, 
    retryFn: () => Promise<void>, 
    error: FingerError
  ): void {
    const state = this.retryStates.get(moduleId);
    if (!state || !state.nextRetryAt) return;

    const delay = state.nextRetryAt.getTime() - Date.now();
    
    this.log.info(`Scheduling retry for ${moduleId}`, {
      moduleId,
      retryCount: state.retryCount,
      delayMs: delay,
      nextRetryAt: state.nextRetryAt.toISOString(),
    });

    const timer = setTimeout(async () => {
      this.retryTimers.delete(moduleId);
      
      if (this.onRetryCallback && state.retryCount <= this.config.maxRetries) {
        try {
          await this.onRetryCallback(moduleId, error);
          await retryFn();
        } catch (err) {
          // 重试失败，会再次触发 handleError
          this.log.error(`Retry failed for ${moduleId}`, err instanceof Error ? err : new Error(String(err)));
        }
      }
    }, Math.max(0, delay));

    this.retryTimers.set(moduleId, timer);
  }
}

// 单例导出
export const errorHandler = new FingerErrorHandler();
