/**
 * Circuit Breaker - 熔断器模块
 *
 * 三态机实现：
 * - closed:   正常状态，请求可以通过
 * - open:     熔断状态，请求被拦截
 * - half-open: 半开状态，允许有限试探请求
 *
 * 状态转换规则：
 * - closed  -> open:     连续失败次数达到 MAX_CONSECUTIVE_FAILURES
 * - open    -> half-open: 经过 RESET_TIMEOUT_MS 时间
 * - half-open -> closed:  试探成功
 * - half-open -> open:    试探失败
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export const MAX_CONSECUTIVE_FAILURES = 3;
export const HALF_OPEN_MAX_ATTEMPTS = 1;
export const RESET_TIMEOUT_MS = 30000;

export interface CircuitBreakerOptions {
  /** 最大连续失败次数阈值 (默认: 3) */
  maxConsecutiveFailures?: number;
  /** 半开状态最大尝试次数 (默认: 1) */
  halfOpenMaxAttempts?: number;
  /** 熔断重置超时时间 (默认: 30000ms) */
  resetTimeoutMs?: number;
}

export interface CircuitBreakerMetrics {
  /** 当前状态 */
  state: CircuitBreakerState;
  /** 连续失败次数 */
  consecutiveFailures: number;
  /** 半开状态尝试次数 */
  halfOpenAttempts: number;
  /** 最近一次状态变化时间戳 */
  lastStateChangeAt: number;
  /** 最近一次失败时间戳 */
  lastFailureAt?: number;
  /** 总成功次数 */
  totalSuccesses: number;
  /** 总失败次数 */
  totalFailures: number;
  /** 被拒绝的请求数（熔断时） */
  rejectedCount: number;
}

/**
 * Circuit Breaker 熔断器类
 *
 * @example
 * ```ts
 * const cb = new CircuitBreaker({ maxConsecutiveFailures: 5 });
 *
 * try {
 *   await cb.execute(async () => {
 *     return await fetchData();
 *   });
 * } catch (e) {
 *   if (cb.isOpen()) {
 *     // 熔断中，使用降级逻辑
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private consecutiveFailures = 0;
  private halfOpenAttempts = 0;
  private lastStateChangeAt = Date.now();
  private lastFailureAt?: number;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private rejectedCount = 0;

  private readonly maxConsecutiveFailures: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly resetTimeoutMs: number;

  /**
   * 创建 CircuitBreaker 实例
   * @param options - 熔断器配置选项
   */
  constructor(options: CircuitBreakerOptions = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? HALF_OPEN_MAX_ATTEMPTS;
    this.resetTimeoutMs = options.resetTimeoutMs ?? RESET_TIMEOUT_MS;
  }

  /**
   * 记录一次成功请求
   * 触发状态转换：half-open -> closed (成功)
   */
  recordSuccess(): void {
    this.totalSuccesses++;
    this.consecutiveFailures = 0;

    if (this.state === 'half-open') {
      // 半开状态成功，切换到 closed
      this.transitionTo('closed');
      this.halfOpenAttempts = 0;
    }
  }

  /**
   * 记录一次失败请求
   * 触发状态转换：closed -> open 或 half-open -> open
   */
  recordFailure(): void {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();

    if (this.state === 'closed') {
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        // 达到阈值，切换到 open
        this.transitionTo('open');
      }
    } else if (this.state === 'half-open') {
      // 半开状态失败，回到 open
      this.transitionTo('open');
      this.halfOpenAttempts = 0;
    }
  }

  /**
   * 检查是否应该熔断（阻断请求）
 * @returns true 如果请求应该被熔断
   */
  shouldCircuitBreak(): boolean {
    this.checkAndTransitionToHalfOpen();

    if (this.state === 'open') {
      this.rejectedCount++;
      return true;
    }

    if (this.state === 'half-open') {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        this.rejectedCount++;
        return true;
      }
      this.halfOpenAttempts++;
    }

    return false;
  }

  /**
   * 熔断入口方法
   * 检查当前状态并决定是否允许请求通过
   * @returns true 如果请求应该被熔断（阻断）
   */
  circuitBreak(): boolean {
    return this.shouldCircuitBreak();
  }

  /**
   * 执行包装函数，自动处理成功/失败记录
   * @param fn - 要执行的异步函数
   * @returns 函数返回值
   * @throws CircuitBreakerOpenError 如果熔断器打开
   * @throws 原始错误 如果执行失败
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.circuitBreak()) {
      throw new CircuitBreakerOpenError('Circuit breaker is open');
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * 获取当前熔断器状态
   */
  getState(): CircuitBreakerState {
    this.checkAndTransitionToHalfOpen();
    return this.state;
  }

  /**
   * 获取当前状态（别名）
   */
  currentState(): CircuitBreakerState {
    return this.getState();
  }

  /**
   * 检查熔断器是否处于 open 状态
   */
  isOpen(): boolean {
    return this.getState() === 'open';
  }

  /**
   * 检查熔断器是否处于 closed 状态
   */
  isClosed(): boolean {
    return this.getState() === 'closed';
  }

  /**
   * 检查熔断器是否处于 half-open 状态
   */
  isHalfOpen(): boolean {
    return this.getState() === 'half-open';
  }

  /**
   * 获取当前指标数据
   */
  getMetrics(): CircuitBreakerMetrics {
    return {
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      halfOpenAttempts: this.halfOpenAttempts,
      lastStateChangeAt: this.lastStateChangeAt,
      lastFailureAt: this.lastFailureAt,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      rejectedCount: this.rejectedCount,
    };
  }

  /**
   * 手动重置熔断器到 closed 状态
   * 用于手动恢复或测试场景
   */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
    this.lastStateChangeAt = Date.now();
    this.rejectedCount = 0;
  }

  /**
   * 检查是否应该从 open 转换到 half-open
   * @private
   */
  private checkAndTransitionToHalfOpen(): void {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastStateChangeAt >= this.resetTimeoutMs) {
        this.transitionTo('half-open');
        this.halfOpenAttempts = 0;
      }
    }
  }

  /**
   * 状态转换
   * @private
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChangeAt = Date.now();

    // 可以在这里添加状态变更钩子/事件
    this.onStateChange?.(oldState, newState);
  }

  /**
   * 状态变更回调钩子（可选）
   */
  onStateChange?: (oldState: CircuitBreakerState, newState: CircuitBreakerState) => void;
}

/**
 * 熔断器打开错误
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * 全局默认熔断器实例
 */
export const defaultCircuitBreaker = new CircuitBreaker();
