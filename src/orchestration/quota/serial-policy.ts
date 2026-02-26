/**
 * Serial Validation Policy - 串行验证策略
 * 
 * Phase 1 专用：强制 effectiveQuota = 1，确保同类任务严格串行执行
 * @see docs/AGENT_MANAGEMENT_IMPLEMENTATION_PLAN.md Phase 1
 */

import {
  DEFAULT_CONCURRENCY_POLICY,
  type ConcurrencyPolicy,
} from '../concurrency-policy.js';

/**
 * 串行验证策略
 * 
 * 特点：
 * - globalMaxConcurrency = 1（全局串行）
 * - 所有资源类型并发上限 = 1
 * - 最小调度收益 = 0（允许短任务也排队）
 * - 队列策略 = fifo（先进先出，保证顺序）
 */
export const SERIAL_VALIDATION_POLICY: ConcurrencyPolicy = {
  ...DEFAULT_CONCURRENCY_POLICY,
  
  // 全局串行
  globalMaxConcurrency: 1,
  
  // 所有资源类型串行
  perResourceConcurrency: {
    executor: 1,
    orchestrator: 1,
    reviewer: 1,
    tool: 1,
    api: 1,
    database: 1,
  },
  
  // 允许任何时长的��务进入队列
  minSchedulingBenefitMs: 0,
  
  // FIFO 保证顺序
  queueStrategy: 'fifo',
  
  // 较长的阻塞超时（串行可能等待较久）
  resourceBlockTimeoutMs: 60000,
  
  // 降级策略：保持串行
  degradationPolicy: {
    resourceUsageThreshold: 0.95,
    degradedMaxConcurrency: 1,
    pauseNewDispatches: false,
  },
};

/**
 * 检查当前是否为串行验证模式
 */
export function isSerialValidationMode(policy: ConcurrencyPolicy): boolean {
  return policy.globalMaxConcurrency === 1;
}

/**
 * 获取队列描述
 */
export function getQueueDescription(position: number, total: number): string {
  if (position === 0) {
    return '即将执行';
  }
  return `队列位置: ${position}/${total}`;
}
