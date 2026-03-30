/**
 * Progress Monitor
 *
 * 刚性进度监控机制：
 * - 定期扫描 ledger/session 生成进度报告
 * - 统计工具调用次数、推理轮次、执行时间等
 * - 通过 AgentStatusSubscriber 或 MessageHub 推送进度
 *
 * 配置：
 * - intervalMs: 心跳间隔（默认 60000ms，即 1 分钟）
 * - enabled: 是否启用（默认 true）
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { logger } from '../../core/logger.js';
import {
  buildContextUsageLine,
  type SessionProgressData,
} from './progress-monitor-utils.js';
import {
  buildCompactSummary,
  buildReportKey as buildReportKeyUtil,
  resolveToolDisplayName,
} from './progress-monitor-reporting.js';
import {
  buildHeartbeatSummary,
  findPendingMeaningfulTool,
  formatElapsed,
  isLowValueTask,
  isLowValueToolCall,
  shouldEmitHeartbeat,
} from './progress-monitor-helpers.js';
import {
  DEFAULT_PROGRESS_MONITOR_CONFIG,
  loadProgressMonitorConfig,
} from './progress-monitor-config.js';
import type {
  ProgressMonitorCallbacks,
  ProgressMonitorConfig,
  ProgressReport,
  SessionProgress,
  ToolCallRecord,
} from './progress-monitor-types.js';
import {
  handleAgentRuntimeDispatch,
  handleAgentRuntimeStatus,
  handleAgentStepCompleted,
  handleModelRound,
  handleSystemNoticeEvent,
  handleToolCallEvent,
  handleToolErrorEvent,
  handleToolResultEvent,
  handleTurnComplete,
  handleTurnStart,
  snippetLimitForTool,
} from './progress-monitor-event-handlers.js';

const log = logger.module('ProgressMonitor');
export type {
  ProgressMonitorCallbacks,
  ProgressMonitorConfig,
  ProgressReport,
  SessionProgress,
  ToolCallRecord,
} from './progress-monitor-types.js';

export class ProgressMonitor {
  private timer: NodeJS.Timeout | null = null;
  private config: Required<ProgressMonitorConfig>;
  // key: `${sessionId}::${agentId}`
  private sessionProgress = new Map<string, SessionProgress>();
  private _stopCleanup: (() => void) | null = null;
  private _cleanupTimer: NodeJS.Timeout | null = null;
  // key: `${sessionId}::${agentId}`
  private latestStepSummary = new Map<string, string>();

  private static readonly LOW_VALUE_TOOLS = new Set([
    'mailbox.status',
    'mailbox.list',
    'mailbox.read',
    'mailbox.ack',
  ]);

  private buildProgressKey(sessionId: string, agentId: string): string {
    return `${sessionId}::${agentId}`;
  }

  private parseEventAgentId(event: any): string | undefined {
    if (typeof event?.agentId === 'string' && event.agentId.trim().length > 0) {
      return event.agentId.trim();
    }
    if (typeof event?.payload?.agentId === 'string' && event.payload.agentId.trim().length > 0) {
      return event.payload.agentId.trim();
    }
    if (typeof event?.payload?.targetAgentId === 'string' && event.payload.targetAgentId.trim().length > 0) {
      return event.payload.targetAgentId.trim();
    }
    return undefined;
  }

  private getProgressEntriesBySession(sessionId: string): Array<[string, SessionProgress]> {
    const entries: Array<[string, SessionProgress]> = [];
    for (const [key, progress] of this.sessionProgress.entries()) {
      if (progress.sessionId === sessionId) entries.push([key, progress]);
    }
    return entries;
  }

  constructor(
    private eventBus: UnifiedEventBus,
    private deps: AgentRuntimeDeps,
    private callbacks?: ProgressMonitorCallbacks,
    config?: ProgressMonitorConfig,
  ) {
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_PROGRESS_MONITOR_CONFIG.intervalMs,
      enabled: config?.enabled ?? DEFAULT_PROGRESS_MONITOR_CONFIG.enabled,
      progressUpdates: config?.progressUpdates ?? DEFAULT_PROGRESS_MONITOR_CONFIG.progressUpdates,
    };
  }

  /**
   * 启动进度监控
   */
  start(): void {
    if (this.timer) {
      log.warn('[ProgressMonitor] Already started');
      return;
    }

    if (!this.config.enabled) {
      log.info('[ProgressMonitor] Disabled by config');
      return;
    }

    log.info(`[ProgressMonitor] Starting with interval ${this.config.intervalMs}ms`);

    // 订阅事件来跟踪进度
    this.subscribeToEvents();
    this.subscribeToReasoningEvents();

    // 启动定期清理已完成 session 的进度记录
    this._cleanupTimer = setInterval(() => this.cleanupCompleted(), 5 * 60 * 1000);

    // 定期生成进度报告
    this.timer = setInterval(() => {
      this.generateProgressReport().catch(err => {
        log.error('[ProgressMonitor] Error generating progress report:', err);
      });
    }, this.config.intervalMs);
  }

  /**
   * 停止进度监控
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._stopCleanup?.();
    this._stopCleanup = null;
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    log.info('[ProgressMonitor] Stopped');
  }

  /**
   * 订阅事件来跟踪进度
   */
  private subscribeToEvents(): void {
    const unsubscribe = this.eventBus.subscribeMultiple(
      ['turn_start', 'turn_complete', 'tool_call', 'tool_result', 'tool_error', 'model_round', 'system_notice', 'agent_runtime_status', 'agent_step_completed', 'agent_runtime_dispatch'],
      (event: any) => {
        this.handleEvent(event).catch(err => {
          log.error('[ProgressMonitor] Error handling event:', err);
        });
      }
    );

    this._stopCleanup = unsubscribe;
  }

  private subscribeToReasoningEvents(): void {
    const unsubscribe = this.eventBus.subscribe('kernel_reasoning', (event: any) => {
      const sessionId = event?.sessionId;
      if (!sessionId) return;

      const text = typeof event?.payload?.text === 'string' ? event.payload.text : '';
      if (text.length > 0) {
        for (const [, progress] of this.getProgressEntriesBySession(sessionId)) {
          progress.latestReasoning = text.slice(0, 120);
        }
      }
    });

    const prev = this._stopCleanup;
    this._stopCleanup = () => {
      unsubscribe();
      prev?.();
    };
  }

  /**
   * 处理事件
   */
  private async handleEvent(event: any): Promise<void> {
    const sessionId = event.sessionId;
    if (!sessionId) return;

    const eventType = event.type;
    const incomingAgentId = this.parseEventAgentId(event);
    const now = Date.now();

    // Session-level event without explicit agentId: update existing entries only.
    if (!incomingAgentId) {
      const sessionEntries = this.getProgressEntriesBySession(sessionId);
      if (sessionEntries.length === 0) return;

      if (eventType === 'system_notice') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleSystemNoticeEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
        }
        return;
      }

      if (eventType === 'turn_start') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleTurnStart(entry, event);
          entry.elapsedMs = now - entry.startTime;
        }
        return;
      }

      if (eventType === 'turn_complete') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleTurnComplete(entry, event);
          entry.elapsedMs = now - entry.startTime;
        }
      }
      return;
    }

    const progressKey = this.buildProgressKey(sessionId, incomingAgentId);
    let progress = this.sessionProgress.get(progressKey);
    if (!progress) {
      progress = {
        sessionId,
        agentId: incomingAgentId,
        startTime: now,
        lastUpdateTime: now,
        toolCallsCount: 0,
        modelRoundsCount: 0,
        reasoningCount: 0,
        status: 'running',
        elapsedMs: 0,
        toolCallHistory: [],
        toolSeqCounter: 0,
      };
      this.sessionProgress.set(progressKey, progress);
    }

    progress.lastUpdateTime = now;
    progress.agentId = incomingAgentId;

    switch (eventType) {
      case 'turn_start':
        handleTurnStart(progress, event);
        break;
      case 'turn_complete':
        handleTurnComplete(progress, event);
        break;
      case 'tool_call':
        handleToolCallEvent(progress, event);
        break;
      case 'tool_result':
        handleToolResultEvent(progress, event);
        break;
      case 'tool_error':
        handleToolErrorEvent(progress, event);
        break;
      case 'model_round':
        handleModelRound(progress, event);
        break;
      case 'system_notice':
        handleSystemNoticeEvent(progress, event);
        break;
      case 'agent_runtime_status':
        handleAgentRuntimeStatus(progress, event);
        break;
      case 'agent_runtime_dispatch':
        handleAgentRuntimeDispatch(progress, event);
        break;
      case 'agent_step_completed':
        handleAgentStepCompleted(progress, event, this.latestStepSummary);
        break;
    }

    progress.elapsedMs = now - progress.startTime;
  }

  /**
   * 生成进度报告并通过 callbacks 推送
   */
  private async generateProgressReport(): Promise<void> {
    if (!this.config.progressUpdates) return;

    const now = Date.now();
    // 获取所有活跃的 session；先按 startTime 刷新 elapsed，避免运行中但尚未回填 elapsedMs 的 session 被漏掉。
    const activeProgress = Array.from(this.sessionProgress.values())
      .filter((p) => {
        if (p.status !== 'running') return false;
        p.elapsedMs = Math.max(0, now - p.startTime);
        return true;
      });

    if (activeProgress.length === 0) return;

    log.debug(`[ProgressMonitor] Generating progress report for ${activeProgress.length} active entries`);

    // 为每个活跃 session 生成并推送进度报告
    for (const p of activeProgress) {
      // Keep elapsed clock moving even when no new events are emitted.
      p.elapsedMs = Math.max(0, now - p.startTime);
      const reportKey = this.buildReportKey(p);
      const stalled = now - p.lastUpdateTime >= this.config.intervalMs;
      if (p.lastReportKey === reportKey) {
        if (!stalled || !this.shouldEmitHeartbeat(p, now)) {
          continue;
        }
      }

      // 仅发送新增工具调用（避免重复）
      const lastReportedSeq = p.lastReportedToolSeq ?? 0;
      const newToolCalls = p.toolCallHistory.filter((tool) => (tool.seq ?? 0) > lastReportedSeq);
      const currentTaskChanged = (p.currentTask ?? '') !== (p.lastReportedCurrentTask ?? '');
      const reasoningChanged = (p.latestReasoning ?? '') !== (p.lastReportedReasoning ?? '');
      const meaningfulToolCalls = newToolCalls.filter((tool) => !this.isLowValueToolCall(tool));
      const meaningfulTaskChange = currentTaskChanged && !this.isLowValueTask(p.currentTask);
      // 只有工具调用、任务变化、reasoning 变化才触发推送；上下文变化不触发。
      const hasMeaningfulSignal = meaningfulToolCalls.length > 0
        || meaningfulTaskChange
        || reasoningChanged;

      // 没有新的真实信号时保持完全静默；不发送任何心跳。
      if (!hasMeaningfulSignal) {
        continue;
      }

      const reportToolCalls = meaningfulToolCalls.length > 0 ? meaningfulToolCalls : newToolCalls.slice(-1);
      const report: ProgressReport = {
        type: 'progress_report',
        timestamp: new Date().toISOString(),
        sessionId: p.sessionId,
        agentId: p.agentId,
        progress: p,
        summary: this.buildSingleProgressSummary(
          p,
          reportToolCalls,
        ),
      };

      if (this.callbacks?.onProgressReport) {
        await this.callbacks.onProgressReport(report);
      }

      // Move dedup cursor only after report delivery succeeds.
      // This avoids dropping updates when callback throws.
      if (newToolCalls.length > 0) {
        const maxSeqInBatch = newToolCalls.reduce((max, tool) => {
          const seq = typeof tool.seq === 'number' && Number.isFinite(tool.seq) ? tool.seq : 0;
          return seq > max ? seq : max;
        }, p.lastReportedToolSeq ?? 0);
        p.lastReportedToolSeq = maxSeqInBatch;
      }
      p.lastReportKey = reportKey;
      p.lastReportTime = now;
      p.lastReportedCurrentTask = p.currentTask;
      p.lastReportedReasoning = p.latestReasoning;
      p.lastReportedContextUsagePercent = p.contextUsagePercent;
      p.lastReportedEstimatedTokensInContextWindow = p.estimatedTokensInContextWindow;
      p.lastReportedMaxInputTokens = p.maxInputTokens;
    }
  }

  /**
   * 构建单个 session 的进度摘要
   */
  private buildSingleProgressSummary(p: SessionProgress, newToolCalls?: ToolCallRecord[]): string {
    const toolsToShow = (newToolCalls && newToolCalls.length > 0) ? newToolCalls : [];
    const firstReport = !p.lastReportTime;
    const currentTaskChanged = (p.currentTask ?? '') !== (p.lastReportedCurrentTask ?? '');
    const reasoningChanged = (p.latestReasoning ?? '') !== (p.lastReportedReasoning ?? '');
    const includeTaskFallback = toolsToShow.length === 0 && !reasoningChanged;
    const data: SessionProgressData = {
      agentId: p.agentId,
      status: p.status,
      currentTask: p.currentTask,
      elapsedMs: p.elapsedMs,
      toolCallHistory: toolsToShow.map(t => ({
        toolName: t.toolName,
        params: t.params,
        success: t.success,
      })),
      latestReasoning: p.latestReasoning,
      contextUsagePercent: p.contextUsagePercent,
      estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
      maxInputTokens: p.maxInputTokens,
    };
    return buildCompactSummary(
      data,
      (ms) => formatElapsed(ms),
      {
        includeTask: firstReport || currentTaskChanged || includeTaskFallback,
        includeReasoning: firstReport || reasoningChanged,
        headerMode: 'minimal',
      },
    );
  }

  private isLowValueTask(task?: string): boolean {
    return isLowValueTask(task);
  }

  private extractCommandFromParams(params?: string): string {
    return '';
  }

  private isLowValueToolCall(tool: ToolCallRecord): boolean {
    return isLowValueToolCall(tool, ProgressMonitor.LOW_VALUE_TOOLS);
  }

  private buildReportKey(p: SessionProgress): string {
    const progressKey = this.buildProgressKey(p.sessionId, p.agentId || 'unknown');
    const data: SessionProgressData = {
      agentId: p.agentId,
      status: p.status,
      currentTask: p.currentTask,
      // Intentionally exclude elapsed wall-clock from dedup key.
      // Otherwise key changes every tick and causes noisy periodic pushes.
      elapsedMs: 0,
      toolCallHistory: p.toolCallHistory.map(t => ({
        toolName: t.toolName,
        params: t.params,
        success: t.success,
      })),
      latestReasoning: p.latestReasoning,
      contextUsagePercent: p.contextUsagePercent,
      estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
      maxInputTokens: p.maxInputTokens,
    };
    return buildReportKeyUtil(data, this.latestStepSummary.get(progressKey));
  }

  private shouldEmitHeartbeat(p: SessionProgress, now: number): boolean {
    return shouldEmitHeartbeat(p, now, this.config.intervalMs);
  }

  private findPendingMeaningfulTool(p: SessionProgress): ToolCallRecord | undefined {
    return findPendingMeaningfulTool(p, ProgressMonitor.LOW_VALUE_TOOLS);
  }

  private buildHeartbeatSummary(p: SessionProgress, now: number, pendingTool: ToolCallRecord): string {
    return buildHeartbeatSummary(p, now, pendingTool);
  }

  /**
   * 格式化时间
   */
  private formatElapsed(ms: number): string {
    return formatElapsed(ms);
  }

  /**
   * 获取指定 session 的进度
   */
  getProgress(sessionId: string): SessionProgress | undefined {
    const entries = this.getProgressEntriesBySession(sessionId).map(([, progress]) => progress);
    if (entries.length === 0) return undefined;

    const running = entries
      .filter((progress) => progress.status === 'running')
      .sort((a, b) => b.lastUpdateTime - a.lastUpdateTime);
    if (running.length > 0) return running[0];

    return entries.sort((a, b) => b.lastUpdateTime - a.lastUpdateTime)[0];
  }

  /**
   * 清理已完成的 session 进度
   */
  cleanupCompleted(): void {
    for (const [progressKey, progress] of this.sessionProgress.entries()) {
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'idle') {
        // 保留最近 5 分钟的完成记录
        if (Date.now() - progress.lastUpdateTime > 5 * 60 * 1000) {
          this.sessionProgress.delete(progressKey);
          this.latestStepSummary.delete(progressKey);
        }
      }
    }
  }

  /**
   * 手动触发进度报告（用于用户请求时）
   */
  async getProgressReport(sessionId: string): Promise<ProgressReport | null> {
    const progress = this.getProgress(sessionId);
    if (!progress) return null;

    return {
      type: 'progress_report',
      timestamp: new Date().toISOString(),
      sessionId,
      agentId: progress.agentId,
      progress,
      summary: this.buildSingleProgressSummary(progress),
    };
  }
}

export default ProgressMonitor;
