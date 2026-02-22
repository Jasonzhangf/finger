/**
 * Concurrency Scheduler - 并发调度器实现
 * 
 * 基于策略的调度决策引擎，负责：
 * 1. 评估任务是否值得并发
 * 2. 检查资源是否满足要求
 * 3. 计算调度收益
 * 4. 管理等待队列和优先级老化
 */

import { resourcePool, type ResourceRequirement } from './resource-pool.js';
import type { TaskNode } from '../agents/daemon/orchestrator-loop.js';
import {
  type ConcurrencyPolicy,
  type SchedulingDecision,
  type ConcurrencyStats,
  DEFAULT_CONCURRENCY_POLICY,
} from './concurrency-policy.js';

interface QueuedTask {
  task: TaskNode;
  enqueuedAt: number;
  basePriority: number;
  currentPriority: number;
  requirements: ResourceRequirement[];
}

interface ExecutionHistory {
  taskType: string;
  avgDurationMs: number;
  successRate: number;
  sampleCount: number;
}

export class ConcurrencyScheduler {
  private policy: ConcurrencyPolicy;
  private queue: QueuedTask[] = [];
  private activeTasks: Map<string, { task: TaskNode; startedAt: number; resources: string[]; requirements: ResourceRequirement[]; enqueuedAt: number }> = new Map();
  private executionHistory: Map<string, ExecutionHistory> = new Map();
  private degradationActive = false;
  private degradationCount = 0;
  private schedulingLatencies: number[] = [];
  
  constructor(policy: ConcurrencyPolicy = DEFAULT_CONCURRENCY_POLICY) {
    this.policy = policy;
  }
  
  /** 更新策略 */
  updatePolicy(newPolicy: Partial<ConcurrencyPolicy>): void {
    this.policy = { ...this.policy, ...newPolicy };
  }
  
  /** 获取当前策略 */
  getPolicy(): ConcurrencyPolicy {
    return { ...this.policy };
  }
  
  /** 评估任务是否应该并发执行 */
  evaluateScheduling(task: TaskNode, requirements: ResourceRequirement[]): SchedulingDecision {
    const now = Date.now();
    
    // 规则 1: 检查依赖是否完成
    if (task.blockedBy && task.blockedBy.length > 0) {
      // 依赖检查需要外部传入状态，这里返回待定
      // 实际调用方应确保依赖已满足
    }
    
    // 规则 2: 检查资源是否满足
    const resourceCheck = resourcePool.checkResourceRequirements(requirements);
    if (!resourceCheck.satisfied) {
      const missingTypes = resourceCheck.missingResources.map(r => r.type).join(', ');
      return {
        allowed: false,
        reason: `资源不满足: 缺少 ${missingTypes}`,
        estimatedStartTime: -1,
        estimatedDurationMs: 0,
        benefitScore: 0,
      };
    }
    
    // 规则 3: 估算执行时间
    const estimatedDuration = this.estimateExecutionTime(task, requirements);
    
    // 规则 4: 计算调度收益
    const benefitScore = this.calculateBenefitScore(estimatedDuration, requirements);
    
    // 规则 5: 检查并发限制
    const concurrencyCheck = this.checkConcurrencyLimits(requirements);
    if (!concurrencyCheck.allowed) {
      return {
        allowed: false,
        reason: concurrencyCheck.reason,
        estimatedStartTime: this.estimateQueueWaitTime(requirements),
        estimatedDurationMs: estimatedDuration,
        benefitScore,
        degradationSuggestion: concurrencyCheck.degradationSuggestion,
      };
    }
    
    // 规则 6: 判断是否值得并发
    if (estimatedDuration < this.policy.minSchedulingBenefitMs && this.activeTasks.size > 0) {
      return {
        allowed: true,
        reason: '任务较短，但无其他并发任务，可以执行',
        estimatedStartTime: now,
        estimatedDurationMs: estimatedDuration,
        benefitScore: benefitScore * 0.5, // 降低收益评分
      };
    }
    
    // 规则 7: 检查降级状态
    if (this.degradationActive && this.policy.degradationPolicy.pauseNewDispatches) {
      return {
        allowed: false,
        reason: '系统降级中，暂停新任务派发',
        estimatedStartTime: -1,
        estimatedDurationMs: estimatedDuration,
        benefitScore: 0,
        degradationSuggestion: {
          suggestedConcurrency: this.policy.degradationPolicy.degradedMaxConcurrency,
          reason: '资源使用率过高，等待释放',
        },
      };
    }
    
    return {
      allowed: true,
      reason: '满足所有调度条件',
      estimatedStartTime: now,
      estimatedDurationMs: estimatedDuration,
      benefitScore,
      resourceAllocation: {
        resourceIds: resourceCheck.satisfiedResources.map(r => r.id),
        estimatedReleaseTime: now + estimatedDuration,
      },
    };
  }
  
  /** 将任务加入等待队列 */
  enqueue(task: TaskNode, requirements: ResourceRequirement[], priority: number = 5): void {
    const now = Date.now();
    const queuedTask: QueuedTask = {
      task,
      enqueuedAt: now,
      basePriority: priority,
      currentPriority: priority,
      requirements,
    };
    
    this.queue.push(queuedTask);
    this.reprioritizeQueue();
  }
  
  /** 从队列中取出最高优先级的可执行任务 */
  dequeue(): QueuedTask | null {
    if (this.queue.length === 0) return null;
    
    this.reprioritizeQueue();
    
    // 找到第一个资源满足的任务
    for (let i = 0; i < this.queue.length; i++) {
      const queued = this.queue[i];
      const decision = this.evaluateScheduling(queued.task, queued.requirements || []);
      
      if (decision.allowed) {
        this.queue.splice(i, 1);
        return queued;
      }
    }
    
    return null;
  }
  
  /** 标记任务开始执行 */
  startTask(taskId: string, resources: string[]): void {
    const queuedIdx = this.queue.findIndex(q => q.task.id === taskId);
    if (queuedIdx >= 0) {
      const queued = this.queue.splice(queuedIdx, 1)[0];
      this.activeTasks.set(taskId, {
        task: queued.task,
        startedAt: Date.now(),
        resources: resources || [],
        requirements: queued.requirements || [],
        enqueuedAt: queued.enqueuedAt || Date.now(),
      });
    }
  }
  
  /** 标记任务完成 */
  completeTask(taskId: string, success: boolean): void {
    const active = this.activeTasks.get(taskId);
    if (!active) return;
    
    const duration = Date.now() - active.startedAt;
    const taskType = this.inferTaskType(active.task);
    
    // 更新执行历史
    this.updateExecutionHistory(taskType, duration, success);
    
    // 记录调度延迟
    const schedulingLatency = active.startedAt - ((active.task as unknown as { enqueuedAt?: number }).enqueuedAt ?? 0);
    this.schedulingLatencies.push(schedulingLatency);
    if (this.schedulingLatencies.length > 100) {
      this.schedulingLatencies.shift();
    }
    
    this.activeTasks.delete(taskId);
    
    // 检查是否需要解除降级
    this.checkDegradationStatus();
  }
  
  /** 获取统计信息 */
  getStats(): ConcurrencyStats {
    const resourceStatus = resourcePool.getStatusReport();
    const resourceUsage: Record<string, { allocated: number; available: number; blocked: number }> = {};
    
    for (const cat of resourceStatus.capabilityCatalog || []) {
      resourceUsage[cat.capability] = {
        allocated: cat.resourceCount - cat.availableCount,
        available: cat.availableCount,
        blocked: 0,
      };
    }
    
    return {
      activeTasks: this.activeTasks.size,
      queuedTasks: this.queue.length,
      resourceUsage,
      avgSchedulingLatencyMs: this.schedulingLatencies.length > 0
        ? this.schedulingLatencies.reduce((a, b) => a + b, 0) / this.schedulingLatencies.length
        : 0,
      avgExecutionTimeMs: this.getAverageExecutionTime(),
      successRate: this.getOverallSuccessRate(),
      degradationCount: this.degradationCount,
    };
  }
  
  /** 估算执行时间 */
  private estimateExecutionTime(task: TaskNode, requirements: ResourceRequirement[]): number {
    const taskType = this.inferTaskType(task);
    
    switch (this.policy.executionTimeEstimator) {
      case 'static': {
        const staticEstimate = this.policy.staticTimeEstimates[taskType];
        if (staticEstimate) return staticEstimate;
        // 根据能力推断
        for (const req of requirements) {
          const capEstimate = this.policy.staticTimeEstimates[req.type];
          if (capEstimate) return capEstimate;
        }
        return 5000; // 默认 5 秒
      }
      
      case 'adaptive': {
        const history = this.executionHistory.get(taskType);
        if (history && history.sampleCount >= 3) {
          // 加权平均历史数据
          const staticEstimate = this.policy.staticTimeEstimates[taskType] || 5000;
          const weight = this.policy.adaptiveHistoryWeight;
          return Math.round(history.avgDurationMs * weight + staticEstimate * (1 - weight));
        }
        return this.policy.staticTimeEstimates[taskType] || 5000;
      }
      
      case 'llm_estimate':
        // LLM 预估需要调用方提供，这里返回保守值
        return 10000;
      
      default:
        return 5000;
    }
  }
  
  /** 计算调度收益评分 */
  private calculateBenefitScore(estimatedDuration: number, requirements: ResourceRequirement[]): number {
    // 基础评分 = 执行时长 / 调度开销
    const overhead = this.policy.estimatedSchedulingOverheadMs;
    const baseScore = Math.min(1, estimatedDuration / (estimatedDuration + overhead));
    
    // 资源稀缺度惩罚
    let scarcityPenalty = 0;
    for (const req of requirements) {
      const available = resourcePool.getResourcesByCapability(req.type, req.minLevel || 1);
      const scarce = available.length <= 1;
      if (scarce) scarcityPenalty += 0.1;
    }
    
    return Math.max(0, baseScore - scarcityPenalty);
  }
  
  /** 检查并发限制 */
  private checkConcurrencyLimits(requirements: ResourceRequirement[]): {
    allowed: boolean;
    reason: string;
    degradationSuggestion?: { suggestedConcurrency: number; reason: string };
  } {
    // 检查全局限制
    const effectiveMaxConcurrency = this.degradationActive
      ? this.policy.degradationPolicy.degradedMaxConcurrency
      : this.policy.globalMaxConcurrency;
    
    if (this.activeTasks.size >= effectiveMaxConcurrency) {
      return {
        allowed: false,
        reason: `全局并发数已达上限 (${this.activeTasks.size}/${effectiveMaxConcurrency})`,
        degradationSuggestion: {
          suggestedConcurrency: Math.max(1, effectiveMaxConcurrency - 1),
          reason: '等待其他任务完成',
        },
      };
    }
    
    // 检查每类资源限制
    for (const req of requirements) {
      const limit = this.policy.perResourceConcurrency[req.type] || 5;
      const current = this.countActiveByResourceType(req.type);
      if (current >= limit) {
        return {
          allowed: false,
          reason: `资源 ${req.type} 并发数已达上限 (${current}/${limit})`,
        };
      }
    }
    
    return { allowed: true, reason: '' };
  }
  
  /** 估算队列等待时间 */
  private estimateQueueWaitTime(_requirements: ResourceRequirement[]): number {
    if (this.activeTasks.size === 0) return 0;
    
    // 取最早完成的活跃任务的预计完成时间
    let minRemainingTime = Infinity;
    for (const [, active] of this.activeTasks) {
      const elapsed = Date.now() - active.startedAt;
      const estimated = this.estimateExecutionTime(active.task, active.requirements || []);
      const remaining = Math.max(0, estimated - elapsed);
      minRemainingTime = Math.min(minRemainingTime, remaining);
    }
    
    return minRemainingTime;
  }
  
  /** 重新计算队列优先级（老化机制） */
  private reprioritizeQueue(): void {
    if (this.policy.queueStrategy !== 'aging') return;
    
    const now = Date.now();
    for (const queued of this.queue) {
      const waitTime = now - queued.enqueuedAt;
      const ageBoost = Math.floor(waitTime / this.policy.agingRateMs);
      queued.currentPriority = queued.basePriority + ageBoost;
    }
    
    // 按优先级降序排序
    this.queue.sort((a, b) => b.currentPriority - a.currentPriority);
  }
  
  /** 推断任务类型 */
  private inferTaskType(task: TaskNode): string {
    const desc = task.description.toLowerCase();
    
    if (desc.includes('搜索') || desc.includes('search')) return 'web_search';
    if (desc.includes('文件') || desc.includes('file')) return 'file_ops';
    if (desc.includes('代码') || desc.includes('code')) return 'code_generation';
    if (desc.includes('执行') || desc.includes('exec')) return 'shell_exec';
    if (desc.includes('报告') || desc.includes('report')) return 'report_generation';
    
    return 'general';
  }
  
  /** 更新执行历史 */
  private updateExecutionHistory(taskType: string, duration: number, success: boolean): void {
    const existing = this.executionHistory.get(taskType);
    
    if (existing) {
      const newCount = existing.sampleCount + 1;
      const newAvg = (existing.avgDurationMs * existing.sampleCount + duration) / newCount;
      const newSuccessRate = (existing.successRate * existing.sampleCount + (success ? 1 : 0)) / newCount;
      
      this.executionHistory.set(taskType, {
        taskType,
        avgDurationMs: Math.round(newAvg),
        successRate: newSuccessRate,
        sampleCount: newCount,
      });
    } else {
      this.executionHistory.set(taskType, {
        taskType,
        avgDurationMs: duration,
        successRate: success ? 1 : 0,
        sampleCount: 1,
      });
    }
  }
  
  /** 计算平均执行时间 */
  private getAverageExecutionTime(): number {
    const histories = Array.from(this.executionHistory.values());
    if (histories.length === 0) return 0;
    
    const total = histories.reduce((sum, h) => sum + h.avgDurationMs * h.sampleCount, 0);
    const count = histories.reduce((sum, h) => sum + h.sampleCount, 0);
    
    return count > 0 ? Math.round(total / count) : 0;
  }
  
  /** 计算整体成功率 */
  private getOverallSuccessRate(): number {
    const histories = Array.from(this.executionHistory.values());
    if (histories.length === 0) return 1;
    
    const totalSuccess = histories.reduce((sum, h) => sum + h.successRate * h.sampleCount, 0);
    const count = histories.reduce((sum, h) => sum + h.sampleCount, 0);
    
    return count > 0 ? totalSuccess / count : 1;
  }
  
  /** 统计某类资源的活跃任务数 */
  private countActiveByResourceType(type: string): number {
    let count = 0;
    for (const [, active] of this.activeTasks) {
      const taskType = this.inferTaskType(active.task);
      if (taskType === type || active.resources.some(r => r.includes(type))) {
        count++;
      }
    }
    return count;
  }
  
  /** 检查降级状态 */
  private checkDegradationStatus(): void {
    const resourceStatus = resourcePool.getStatusReport();
    const totalResources = resourceStatus.totalResources;
    const busyResources = resourceStatus.busy + resourceStatus.deployed;
    
    if (totalResources === 0) return;
    
    const usageRate = busyResources / totalResources;
    
    if (usageRate > this.policy.degradationPolicy.resourceUsageThreshold) {
      if (!this.degradationActive) {
        this.degradationActive = true;
        this.degradationCount++;
        console.log(`[ConcurrencyScheduler] 降级激活: 资源使用率 ${Math.round(usageRate * 100)}%`);
      }
    } else {
      if (this.degradationActive) {
        this.degradationActive = false;
        console.log(`[ConcurrencyScheduler] 降级解除: 资源使用率 ${Math.round(usageRate * 100)}%`);
      }
    }
  }
}

// 单例实例
export const concurrencyScheduler = new ConcurrencyScheduler();
