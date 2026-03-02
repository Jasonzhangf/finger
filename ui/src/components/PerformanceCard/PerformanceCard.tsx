import React, { useState, useEffect } from 'react';
import './PerformanceCard.css';

interface PerformanceMetrics {
  timestamp: number;
  scheduling: {
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalDispatches: number;
    queuedTasks: number;
    activeTasks: number;
  };
  execution: {
    avgDurationMs: number;
    successRate: number;
    totalCompleted: number;
    totalFailed: number;
  };
  eventBus: {
    eventsPerSecond: number;
    totalEvents: number;
  };
  resourcePool: {
    utilizationRate: number;
    availableCount: number;
    busyCount: number;
  };
  system: {
    memoryUsedMB: number;
    uptimeSeconds: number;
  };
}

export const PerformanceCard: React.FC = () => {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

  useEffect(() => {
    // Fetch initial metrics
    fetchMetrics();

    // Poll every 5 seconds
    const interval = setInterval(fetchMetrics, 5000);

    // Listen for WebSocket performance updates
    const handlePerformanceMetrics = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'performance_metrics') {
          setMetrics(data.payload);
        }
      } catch {
        // Ignore parse errors
      }
    };

    // Connect to WebSocket for real-time updates
    const ws = new WebSocket(`ws://${window.location.hostname}:5522`);
    ws.onmessage = handlePerformanceMetrics;

    return () => {
      clearInterval(interval);
      ws.close();
    };
  }, []);

  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/v1/performance');
      const data = await res.json();
      if (data.success && data.metrics) {
        setMetrics(data.metrics);
      }
    } catch {
      // Ignore fetch errors
    }
  };

  const getStatusClass = (value: number, thresholds: { warning: number; critical: number }) => {
    if (value >= thresholds.critical) return 'critical';
    if (value >= thresholds.warning) return 'warning';
    return 'good';
  };

  const getOverallStatus = (): 'good' | 'warning' | 'critical' => {
    if (!metrics) return 'good';
    
    if (metrics.system.memoryUsedMB > 512) return 'critical';
    if (metrics.execution.successRate < 0.8) return 'critical';
    if (metrics.scheduling.p95LatencyMs > 5000) return 'warning';
    if (metrics.resourcePool.utilizationRate > 0.85) return 'warning';
    
    return 'good';
  };

  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  };

  if (!metrics) {
    return (
      <div className="performance-bar">
        <div className="performance-bar-title">
          <span className="performance-indicator"></span>
          Performance
        </div>
        <div className="performance-bar-loading">Loading...</div>
      </div>
    );
  }

  const status = getOverallStatus();

  return (
    <div className={`performance-bar ${status}`}>
      <div className="performance-bar-title">
        <span className={`performance-indicator ${status}`}></span>
        Performance
      </div>
      <div className="performance-bar-metrics">
        <span className={`metric-chip ${getStatusClass(metrics.scheduling.avgLatencyMs, { warning: 1000, critical: 5000 })}`}>
          延迟 {metrics.scheduling.avgLatencyMs}ms
        </span>
        <span className={`metric-chip ${getStatusClass(1 - metrics.execution.successRate, { warning: 0.1, critical: 0.2 })}`}>
          成功 {(metrics.execution.successRate * 100).toFixed(0)}%
        </span>
        <span className="metric-chip">
          活跃 {metrics.scheduling.activeTasks}/{metrics.scheduling.queuedTasks}
        </span>
        <span className={`metric-chip ${getStatusClass(metrics.resourcePool.utilizationRate, { warning: 0.7, critical: 0.9 })}`}>
          资源 {(metrics.resourcePool.utilizationRate * 100).toFixed(0)}%
        </span>
        <span className="metric-chip">
          事件 {metrics.eventBus.eventsPerSecond}/s
        </span>
        <span className={`metric-chip ${getStatusClass(metrics.system.memoryUsedMB, { warning: 256, critical: 512 })}`}>
          内存 {metrics.system.memoryUsedMB}MB
        </span>
        <span className="metric-chip subtle">
          运行 {formatUptime(metrics.system.uptimeSeconds)}
        </span>
      </div>
    </div>
  );
};
