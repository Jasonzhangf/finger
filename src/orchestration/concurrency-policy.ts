/**
 * Concurrency Policy - 并发调度策略配置
 * 
 * 策略原则：
 * 1. 可并行：任务在 DAG 上无未完成前置依赖
 * 2. 资源齐全：任务声明的 requiredCapabilities 全部可分配
 * 3. 值得并发：预计执行时长大于调度开销阈值（默认 > 2s）
 * 4. 不过载：不超过每类资源并发上限和系统总并发预算
 * 5. 可回收：线程结束后释放资源；超时/失败进入重试或人工决策
 * 6. 阻塞任务：资源被占用则进入等待队列，不抢占关键任务
 * 7. 不可恢复缺资源：立即上报用户，不进入盲等
 */

export interface ConcurrencyPolicy {
  /** 全局最大并发任务数 */
  globalMaxConcurrency: number;
  
  /** 每类资源的最大并发数 */
  perResourceConcurrency: Record<string, number>;
  
  /** 最小调度收益阈值（毫秒）
   * 只有当预计执行时间 > 此值时才值得并发
   */
  minSchedulingBenefitMs: number;
  
  /** 调度开销估算（毫秒）
   * 包括：资源分配、上下文切换、结果合并等
   */
  estimatedSchedulingOverheadMs: number;
  
  /** 任务执行时间预估策略 */
  executionTimeEstimator: 'static' | 'adaptive' | 'llm_estimate';
  
  /** 静态预估时长映射（用于 static 模式） */
  staticTimeEstimates: Record<string, number>;
  
  /** 自适应历史权重（用于 adaptive 模式）
   * 0-1 之间，越高越依赖历史数据
   */
  adaptiveHistoryWeight: number;
  
  /** 队列策略 */
  queueStrategy: 'fifo' | 'priority' | 'aging';
  
  /** 优先级老化系数（用于 aging 策略）
   * 每等待 N 毫秒，优先级提升 1
   */
  agingRateMs: number;
  
  /** 资源阻塞超时（毫秒）
   * 超过此时间未获得资源则上报用户
   */
  resourceBlockTimeoutMs: number;
  
  /** 任务执行超时（毫秒） */
  taskExecutionTimeoutMs: number;
  
  /** 失败重试策略 */
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
    maxBackoffMs: number;
    retryableErrors: string[];
  };
  
  /** 动态降级策略 */
  degradationPolicy: {
    /** 当资源使用率超过此阈值时启用降级 */
    resourceUsageThreshold: number;
    /** 降级后的最大并发数 */
    degradedMaxConcurrency: number;
    /** 是否暂停新任务派发 */
    pauseNewDispatches: boolean;
  };
}

/** 任务调度决策结果 */
export interface SchedulingDecision {
  /** 是否允许调度 */
  allowed: boolean;
  
  /** 决策原因 */
  reason: string;
  
  /** 预计开始时间 */
  estimatedStartTime: number;
  
  /** 预计执行时长（毫秒） */
  estimatedDurationMs: number;
  
  /** 调度收益评分（0-1） */
  benefitScore: number;
  
  /** 资源分配建议 */
  resourceAllocation?: {
    resourceIds: string[];
    estimatedReleaseTime: number;
  };
  
  /** 降级建议 */
  degradationSuggestion?: {
    suggestedConcurrency: number;
    reason: string;
  };
}

/** 并发调度器统计 */
export interface ConcurrencyStats {
  /** 当前运行中任务数 */
  activeTasks: number;
  
  /** 等待队列长度 */
  queuedTasks: number;
  
  /** 各类资源使用情况 */
  resourceUsage: Record<string, {
    allocated: number;
    available: number;
    blocked: number;
  }>;
  
  /** 平均调度延迟（毫秒） */
  avgSchedulingLatencyMs: number;
  
  /** 平均任务执行时长（毫秒） */
  avgExecutionTimeMs: number;
  
  /** 任务成功率 */
  successRate: number;
  
  /** 降级次数 */
  degradationCount: number;
}

/** 默认并发策略 */
export const DEFAULT_CONCURRENCY_POLICY: ConcurrencyPolicy = {
  globalMaxConcurrency: 5,
  perResourceConcurrency: {
    executor: 3,
    orchestrator: 1,
    reviewer: 2,
    searcher: 2,
    tool: 5,
    api: 10,
    database: 3,
  },
  minSchedulingBenefitMs: 2000,
  estimatedSchedulingOverheadMs: 500,
  executionTimeEstimator: 'adaptive',
  staticTimeEstimates: {
    'web_search': 5000,
    'file_ops': 1000,
    'code_generation': 10000,
    'shell_exec': 3000,
    'report_generation': 8000,
  },
  adaptiveHistoryWeight: 0.7,
  queueStrategy: 'aging',
  agingRateMs: 5000,
  resourceBlockTimeoutMs: 30000,
  taskExecutionTimeoutMs: 120000,
  retryPolicy: {
    maxRetries: 2,
    backoffMs: 1000,
    maxBackoffMs: 30000,
    retryableErrors: ['timeout', 'rate_limit', 'temporary_failure'],
  },
  degradationPolicy: {
    resourceUsageThreshold: 0.85,
    degradedMaxConcurrency: 2,
    pauseNewDispatches: false,
  },
};

/** 高性能模式策略 */
export const HIGH_PERFORMANCE_POLICY: ConcurrencyPolicy = {
  ...DEFAULT_CONCURRENCY_POLICY,
  globalMaxConcurrency: 10,
  perResourceConcurrency: {
    executor: 6,
    orchestrator: 2,
    reviewer: 4,
    searcher: 4,
    tool: 10,
    api: 20,
    database: 6,
  },
  minSchedulingBenefitMs: 1000,
  degradationPolicy: {
    resourceUsageThreshold: 0.90,
    degradedMaxConcurrency: 5,
    pauseNewDispatches: false,
  },
};

/** 保守模式策略（资源受限环境） */
export const CONSERVATIVE_POLICY: ConcurrencyPolicy = {
  ...DEFAULT_CONCURRENCY_POLICY,
  globalMaxConcurrency: 2,
  perResourceConcurrency: {
    executor: 1,
    orchestrator: 1,
    reviewer: 1,
    searcher: 1,
    tool: 2,
    api: 3,
    database: 1,
  },
  minSchedulingBenefitMs: 5000,
  queueStrategy: 'fifo',
  degradationPolicy: {
    resourceUsageThreshold: 0.70,
    degradedMaxConcurrency: 1,
    pauseNewDispatches: true,
  },
};
