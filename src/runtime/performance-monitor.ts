/**
 * Performance Monitor - 运行时性能监控
 * 
 * 收集关键性能指标：
 * - 调度延迟 (Scheduling Latency)
 * - 任务执行时长 (Task Execution Time)
 * - 事件总线吞吐量 (Event Bus Throughput)
 * - 内存使用 (Memory Usage)
 * - 资源池利用率 (Resource Pool Utilization)
 */

import { EventEmitter } from 'events';

export interface PerformanceMetrics {
  timestamp: number;
  
  // 调度性能
  scheduling: {
    avgLatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    totalDispatches: number;
    queuedTasks: number;
    activeTasks: number;
  };
  
  // 任务执行
  execution: {
    avgDurationMs: number;
    p95DurationMs: number;
    successRate: number;
    totalCompleted: number;
    totalFailed: number;
  };
  
  // 事件总线
  eventBus: {
    eventsPerSecond: number;
    totalEvents: number;
    avgProcessingTimeMs: number;
  };
  
  // 资源池
  resourcePool: {
    utilizationRate: number;
    availableCount: number;
    busyCount: number;
    blockedCount: number;
  };
  
  // 系统资源
  system: {
    memoryUsedMB: number;
    memoryTotalMB: number;
    cpuUsagePercent: number;
    uptimeSeconds: number;
  };
}

export class PerformanceMonitor extends EventEmitter {
  private metrics: PerformanceMetrics | null = null;
  private startTime = Date.now();
  private eventCounts: { timestamp: number; count: number }[] = [];
  private eventProcessingTimes: number[] = [];
  
  // 调度延迟记录
  private schedulingLatencies: number[] = [];
  
  // 任务执行记录
  private executionDurations: { duration: number; success: boolean }[] = [];
  
  constructor(private samplingIntervalMs: number = 5000) {
    super();
    this.startCollecting();
  }
  
  /** 记录调度延迟 */
  recordSchedulingLatency(latencyMs: number): void {
    this.schedulingLatencies.push(latencyMs);
    if (this.schedulingLatencies.length > 1000) {
      this.schedulingLatencies.shift();
    }
  }
  
  /** 记录任务执行 */
  recordTaskExecution(durationMs: number, success: boolean): void {
    this.executionDurations.push({ duration: durationMs, success });
    if (this.executionDurations.length > 1000) {
      this.executionDurations.shift();
    }
  }
  
  /** 记录事件处理 */
  recordEvent(count: number, processingTimeMs: number): void {
    this.eventCounts.push({ timestamp: Date.now(), count });
    this.eventProcessingTimes.push(processingTimeMs);
    
    // 清理过期数据（保留最近60秒）
    const cutoff = Date.now() - 60000;
    this.eventCounts = this.eventCounts.filter(e => e.timestamp > cutoff);
    if (this.eventProcessingTimes.length > 1000) {
      this.eventProcessingTimes.shift();
    }
  }
  
  /** 获取当前性能指标 */
  getMetrics(): PerformanceMetrics {
    return this.calculateMetrics();
  }
  
  /** 获取调度统计 */
  getSchedulingStats(): {
    avgLatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    totalDispatches: number;
  } {
    const latencies = this.schedulingLatencies;
    if (latencies.length === 0) {
      return { avgLatencyMs: 0, p95LatencyMs: 0, p99LatencyMs: 0, totalDispatches: 0 };
    }
    
    const sorted = [...latencies].sort((a, b) => a - b);
    return {
      avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p95LatencyMs: sorted[Math.floor(sorted.length * 0.95)] || 0,
      p99LatencyMs: sorted[Math.floor(sorted.length * 0.99)] || 0,
      totalDispatches: latencies.length,
    };
  }
  
  /** 获取执行统计 */
  getExecutionStats(): {
    avgDurationMs: number;
    p95DurationMs: number;
    successRate: number;
    totalCompleted: number;
    totalFailed: number;
  } {
    if (this.executionDurations.length === 0) {
      return { avgDurationMs: 0, p95DurationMs: 0, successRate: 1, totalCompleted: 0, totalFailed: 0 };
    }
    
    const durations = this.executionDurations.map(d => d.duration);
    const sorted = [...durations].sort((a, b) => a - b);
    const successful = this.executionDurations.filter(d => d.success).length;
    
    return {
      avgDurationMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      p95DurationMs: sorted[Math.floor(sorted.length * 0.95)] || 0,
      successRate: successful / this.executionDurations.length,
      totalCompleted: successful,
      totalFailed: this.executionDurations.length - successful,
    };
  }
  
  /** 计算事件吞吐量 */
  getEventThroughput(): { eventsPerSecond: number; avgProcessingTimeMs: number } {
    const cutoff = Date.now() - 60000;
    const recentEvents = this.eventCounts.filter(e => e.timestamp > cutoff);
    const totalCount = recentEvents.reduce((sum, e) => sum + e.count, 0);
    
    const avgProcessingTime = this.eventProcessingTimes.length > 0
      ? this.eventProcessingTimes.reduce((a, b) => a + b, 0) / this.eventProcessingTimes.length
      : 0;
    
    return {
      eventsPerSecond: Math.round((totalCount / 60) * 10) / 10,
      avgProcessingTimeMs: Math.round(avgProcessingTime),
    };
  }
  
  /** 获取系统资源使用 */
  private getSystemStats(): {
    memoryUsedMB: number;
    memoryTotalMB: number;
    cpuUsagePercent: number;
    uptimeSeconds: number;
  } {
    const memUsage = process.memoryUsage();
    
    return {
      memoryUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      memoryTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      cpuUsagePercent: Math.round(process.cpuUsage().user / 1000000), // 转换为秒
      uptimeSeconds: Math.round((Date.now() - this.startTime) / 1000),
    };
  }
  
  /** 计算所有指标 */
  private calculateMetrics(): PerformanceMetrics {
    const scheduling = this.getSchedulingStats();
    const execution = this.getExecutionStats();
    const eventBus = this.getEventThroughput();
    const system = this.getSystemStats();
    
    // 资源池状态（从全局实例获取）
    const resourcePoolStats = {
      utilizationRate: 0,
      availableCount: 0,
      busyCount: 0,
      blockedCount: 0,
    };
    
    return {
      timestamp: Date.now(),
      scheduling: {
        ...scheduling,
        queuedTasks: 0, // 从调度器获取
        activeTasks: 0,
      },
      execution,
      eventBus: {
        ...eventBus,
        totalEvents: this.eventCounts.reduce((sum, e) => sum + e.count, 0),
      },
      resourcePool: resourcePoolStats,
      system,
    };
  }
  
  /** 开始定期收集 */
  private startCollecting(): void {
    setInterval(() => {
      this.metrics = this.calculateMetrics();
      this.emit('metrics', this.metrics);
      
      // 检查性能阈值
      this.checkThresholds(this.metrics);
    }, this.samplingIntervalMs);
  }
  
  /** 检查性能阈值 */
  private checkThresholds(metrics: PerformanceMetrics): void {
    // 调度延迟过高
    if (metrics.scheduling.p95LatencyMs > 5000) {
      this.emit('alert', {
        type: 'high_scheduling_latency',
        message: `P95调度延迟过高: ${metrics.scheduling.p95LatencyMs}ms`,
        severity: 'warning',
      });
    }
    
    // 内存使用过高
    if (metrics.system.memoryUsedMB > 512) {
      this.emit('alert', {
        type: 'high_memory_usage',
        message: `内存使用过高: ${metrics.system.memoryUsedMB}MB`,
        severity: 'warning',
      });
    }
    
    // 任务失败率过高
    if (metrics.execution.successRate < 0.8) {
      this.emit('alert', {
        type: 'low_success_rate',
        message: `任务成功率过低: ${(metrics.execution.successRate * 100).toFixed(1)}%`,
        severity: 'critical',
      });
    }
  }
  
  /** 生成性能报告 */
  generateReport(): string {
    const m = this.calculateMetrics();
    
    return `
=== Finger 性能报告 ===
生成时间: ${new Date(m.timestamp).toISOString()}

【调度性能】
- 平均延迟: ${m.scheduling.avgLatencyMs}ms
- P95延迟: ${m.scheduling.p95LatencyMs}ms
- P99延迟: ${m.scheduling.p99LatencyMs}ms
- 总派发: ${m.scheduling.totalDispatches}

【任务执行】
- 平均时长: ${m.execution.avgDurationMs}ms
- P95时长: ${m.execution.p95DurationMs}ms
- 成功率: ${(m.execution.successRate * 100).toFixed(1)}%
- 完成/失败: ${m.execution.totalCompleted}/${m.execution.totalFailed}

【事件总线】
- 吞吐量: ${m.eventBus.eventsPerSecond} 事件/秒
- 平均处理: ${m.eventBus.avgProcessingTimeMs}ms
- 总事件: ${m.eventBus.totalEvents}

【系统资源】
- 内存: ${m.system.memoryUsedMB}/${m.system.memoryTotalMB}MB
- CPU: ${m.system.cpuUsagePercent}%
- 运行时间: ${Math.floor(m.system.uptimeSeconds / 60)}分
`;
  }
}

// 单例实例
export const performanceMonitor = new PerformanceMonitor();
