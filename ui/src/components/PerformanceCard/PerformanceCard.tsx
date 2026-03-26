import React, { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket.js';
import type { RuntimeOverview } from '../../hooks/useWorkflowExecution.types.js';
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

export const PerformanceCard: React.FC<{
  paused?: boolean;
  runtimeOverview?: RuntimeOverview;
  onContextAction?: (action: 'focus_latest_round' | 'focus_latest_strategy_change' | 'step_compare_prev' | 'step_compare_next') => void;
}> = ({
  paused = false,
  runtimeOverview,
  onContextAction,
}) => {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [lastWsMessageAt, setLastWsMessageAt] = useState<number | null>(null);
  const [lastLiveEventAt, setLastLiveEventAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleWebSocketMessage = useCallback((msg: { type: string; payload?: unknown }) => {
    if (paused) return;
    const now = Date.now();
    setLastWsMessageAt(now);
    if (
      msg.type !== 'performance_metrics'
      && msg.type !== 'subscribe_confirmed'
      && msg.type !== 'client_id_assigned'
    ) {
      setLastLiveEventAt(now);
    }
    if (msg.type !== 'performance_metrics') return;
    const payload = msg.payload as Record<string, unknown> | null;
    const next = payload && typeof payload === 'object' && payload !== null && 'metrics' in payload
      ? (payload as { metrics?: PerformanceMetrics }).metrics
      : (payload as PerformanceMetrics | null);
    if (next) {
      setMetrics(next);
    }
  }, [paused]);

  const { isConnected } = useWebSocket(handleWebSocketMessage);

  const ageSeconds = (timestamp: number | null): number | null => {
    if (!timestamp) return null;
    return Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  };

  const wsAge = ageSeconds(lastWsMessageAt);
  const liveEventAge = ageSeconds(lastLiveEventAt);

  const wsChipClass = !isConnected
    ? 'critical'
    : wsAge == null
      ? 'warning'
      : wsAge > 12
        ? 'warning'
        : 'good';

  const liveEventChipClass = (() => {
    if (!isConnected) return 'critical';
    const activeTasks = metrics?.scheduling.activeTasks ?? 0;
    if (activeTasks > 0) {
      if (liveEventAge == null || liveEventAge > 20) return 'critical';
      if (liveEventAge > 8) return 'warning';
      return 'good';
    }
    if (liveEventAge == null) return 'subtle';
    if (liveEventAge > 120) return 'warning';
    return 'good';
  })();

  const wsText = !isConnected
    ? 'WS 断开'
    : wsAge == null
      ? 'WS 连接中'
      : `WS ${wsAge}s`;

  const liveEventText = liveEventAge == null
    ? '实时事件 idle'
    : `实时事件 ${liveEventAge}s`;

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

  const formatSigned = (value: number): string => (value > 0 ? `+${value}` : `${value}`);
  const formatCompactTokens = (value: number): string => {
    if (!Number.isFinite(value)) return `${value}`;
    if (value >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`;
    }
    if (value >= 1_000) {
      return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
    }
    return `${Math.floor(value)}`;
  };
  const computeContextUsage = (): number | undefined => {
    if (typeof runtimeOverview?.contextUsagePercent === 'number') {
      return Math.max(0, Math.floor(runtimeOverview.contextUsagePercent));
    }
    if (
      typeof runtimeOverview?.contextTokensInWindow === 'number'
      && typeof runtimeOverview?.contextMaxInputTokens === 'number'
      && runtimeOverview.contextMaxInputTokens > 0
    ) {
      return Math.max(0, Math.floor((runtimeOverview.contextTokensInWindow / runtimeOverview.contextMaxInputTokens) * 100));
    }
    return undefined;
  };
  const contextUsage = computeContextUsage();
  const contextThreshold = typeof runtimeOverview?.contextThresholdPercent === 'number'
    ? Math.max(1, Math.floor(runtimeOverview.contextThresholdPercent))
    : 75;
  const contextChipClass = (() => {
    if (contextUsage === undefined) return 'subtle';
    if (contextUsage >= contextThreshold + 10) return 'critical';
    if (contextUsage >= contextThreshold) return 'warning';
    return 'good';
  })();
  const contextAbsoluteText = (() => {
    if (typeof runtimeOverview?.contextTokensInWindow === 'number' && typeof runtimeOverview?.contextMaxInputTokens === 'number') {
      const usage = contextUsage !== undefined ? `${contextUsage}%` : '?%';
      return `上下文 ${formatCompactTokens(runtimeOverview.contextTokensInWindow)}/${formatCompactTokens(runtimeOverview.contextMaxInputTokens)} (${usage})`;
    }
    if (contextUsage !== undefined) {
      return `上下文 ${contextUsage}%`;
    }
    if (typeof runtimeOverview?.contextTokensInWindow === 'number') {
      return `上下文 ${formatCompactTokens(runtimeOverview.contextTokensInWindow)} tokens`;
    }
    return null;
  })();
  const strategyLabel = runtimeOverview?.contextStrategyLabel;
  const strategyChipClass = runtimeOverview?.contextBuilderBypassed === true
    ? 'warning'
    : strategyLabel && strategyLabel.includes('CONTEXT_BUILDER')
      ? 'good'
      : 'subtle';
  const strategySwitchText = runtimeOverview?.contextStrategyChanged
    ? `策略切换 ${runtimeOverview.contextPrevStrategyLabel || '?'} → ${runtimeOverview.contextStrategyLabel || '?'}`
    : null;

  if (!metrics) {
    return (
      <div className="performance-bar">
        <div className="performance-bar-title">
          <span className="performance-indicator"></span>
          Performance
        </div>
        <div className="performance-bar-metrics">
          <span className={`metric-chip ${wsChipClass}`}>{wsText}</span>
          <span className={`metric-chip ${liveEventChipClass}`}>{liveEventText}</span>
          <span className="performance-bar-loading">Waiting for metrics...</span>
        </div>
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
        <span className={`metric-chip ${wsChipClass}`}>
          {wsText}
        </span>
        <span className={`metric-chip ${liveEventChipClass}`}>
          {liveEventText}
        </span>
        {contextAbsoluteText && (
          <span
            className={`metric-chip ${contextChipClass}`}
            title={`Context threshold ${contextThreshold}%`}
          >
            {contextAbsoluteText}
          </span>
        )}
        {strategyLabel && (
          <button
            type="button"
            className={`metric-chip metric-chip-button ${strategyChipClass}`}
            onClick={() => { onContextAction?.('focus_latest_round'); }}
            title="定位到 Context Monitor 的最新 round"
          >
            策略 {strategyLabel}
          </button>
        )}
        {strategySwitchText && (
          <button
            type="button"
            className="metric-chip metric-chip-button warning"
            onClick={() => { onContextAction?.('focus_latest_strategy_change'); }}
            title="定位到最近一次策略切换 round"
          >
            {strategySwitchText}
          </button>
        )}
        {typeof runtimeOverview?.contextHistoryDelta === 'number' && (
          <span className={`metric-chip ${runtimeOverview.contextHistoryDelta === 0 ? 'subtle' : runtimeOverview.contextHistoryDelta > 0 ? 'warning' : 'good'}`}>
            Δhistory {formatSigned(runtimeOverview.contextHistoryDelta)}
          </span>
        )}
        {typeof runtimeOverview?.contextTokensDelta === 'number' && (
          <span className={`metric-chip ${runtimeOverview.contextTokensDelta === 0 ? 'subtle' : runtimeOverview.contextTokensDelta > 0 ? 'warning' : 'good'}`}>
            Δctx {formatSigned(runtimeOverview.contextTokensDelta)}
          </span>
        )}
        {typeof runtimeOverview?.contextUsageDelta === 'number' && (
          <span className={`metric-chip ${runtimeOverview.contextUsageDelta === 0 ? 'subtle' : runtimeOverview.contextUsageDelta > 0 ? 'warning' : 'good'}`}>
            Δusage {formatSigned(runtimeOverview.contextUsageDelta)}%
          </span>
        )}
        <button
          type="button"
          className="metric-chip metric-chip-button subtle"
          onClick={() => { onContextAction?.('step_compare_prev'); }}
          title="Context 对比基线向前回溯"
        >
          对比←
        </button>
        <button
          type="button"
          className="metric-chip metric-chip-button subtle"
          onClick={() => { onContextAction?.('step_compare_next'); }}
          title="Context 对比基线向后回溯"
        >
          对比→
        </button>
        <span className="metric-chip subtle">
          运行 {formatUptime(metrics.system.uptimeSeconds)}
        </span>
      </div>
    </div>
  );
};
