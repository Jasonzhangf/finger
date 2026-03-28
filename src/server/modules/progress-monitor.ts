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
  buildCompactSummary,
  buildContextUsageLine,
  buildReportKey as buildReportKeyUtil,
  resolveToolDisplayName,
  type SessionProgressData,
} from './progress-monitor-utils.js';
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
  private sessionProgress = new Map<string, SessionProgress>();
  private _stopCleanup: (() => void) | null = null;
  private _cleanupTimer: NodeJS.Timeout | null = null;
  private latestStepSummary = new Map<string, string>(); // sessionId -> latest step summary

  private static readonly LOW_VALUE_TOOLS = new Set([
    'mailbox.status',
    'mailbox.list',
    'mailbox.read',
    'mailbox.ack',
  ]);

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
      const progress = this.sessionProgress.get(sessionId);
      if (!progress) return;

      const text = typeof event?.payload?.text === 'string' ? event.payload.text : '';
      if (text.length > 0) {
        progress.latestReasoning = text.slice(0, 120);
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
    const incomingAgentId = typeof event.agentId === 'string' && event.agentId.trim().length > 0
      ? event.agentId.trim()
      : (typeof event.payload?.agentId === 'string' && event.payload.agentId.trim().length > 0
          ? event.payload.agentId.trim()
          : undefined);

    // 获取或创建进度记录
    let progress = this.sessionProgress.get(sessionId);
    if (!progress) {
      const now = Date.now();
      progress = {
        sessionId,
        agentId: incomingAgentId || 'unknown',
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
      this.sessionProgress.set(sessionId, progress);
    }

    // 更新进度
    progress.lastUpdateTime = Date.now();
    if (incomingAgentId) {
      progress.agentId = incomingAgentId;
    }

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

    progress.elapsedMs = Date.now() - progress.startTime;
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

    log.debug(`[ProgressMonitor] Generating progress report for ${activeProgress.length} sessions`);

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
      const contextChanged =
        p.contextUsagePercent !== p.lastReportedContextUsagePercent
        || p.estimatedTokensInContextWindow !== p.lastReportedEstimatedTokensInContextWindow
        || p.maxInputTokens !== p.lastReportedMaxInputTokens;
      const meaningfulToolCalls = newToolCalls.filter((tool) => !this.isLowValueToolCall(tool));
      const meaningfulTaskChange = currentTaskChanged && !this.isLowValueTask(p.currentTask);
      const shouldHeartbeat = this.shouldEmitHeartbeat(p, now);
      const pendingMeaningfulTool = this.findPendingMeaningfulTool(p);
      const hasMeaningfulSignal = meaningfulToolCalls.length > 0
        || meaningfulTaskChange
        || reasoningChanged
        || contextChanged;

      // 没有新的真实信号时保持静默；不要伪造“等待模型响应”心跳。
      // 只有明确存在未完成的工具调用时，才允许发送等待类更新。
      if (!hasMeaningfulSignal) {
        if (!shouldHeartbeat || !pendingMeaningfulTool) {
          continue;
        }

        const heartbeatReport: ProgressReport = {
          type: 'progress_report',
          timestamp: new Date().toISOString(),
          sessionId: p.sessionId,
          agentId: p.agentId,
          progress: p,
          summary: this.buildHeartbeatSummary(p, now, pendingMeaningfulTool),
        };

        p.lastReportTime = now;
        if (this.callbacks?.onProgressReport) {
          await this.callbacks.onProgressReport(heartbeatReport);
        }
        continue;
      }

      const report: ProgressReport = {
        type: 'progress_report',
        timestamp: new Date().toISOString(),
        sessionId: p.sessionId,
        agentId: p.agentId,
        progress: p,
        summary: this.buildSingleProgressSummary(p, meaningfulToolCalls),
      };

      p.lastReportKey = reportKey;
      p.lastReportTime = now;
      p.lastReportedToolSeq = p.toolSeqCounter ?? p.lastReportedToolSeq ?? 0;
      p.lastReportedCurrentTask = p.currentTask;
      p.lastReportedReasoning = p.latestReasoning;
      p.lastReportedContextUsagePercent = p.contextUsagePercent;
      p.lastReportedEstimatedTokensInContextWindow = p.estimatedTokensInContextWindow;
      p.lastReportedMaxInputTokens = p.maxInputTokens;

      if (this.callbacks?.onProgressReport) {
        await this.callbacks.onProgressReport(report);
      }
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
      (ms) => this.formatElapsed(ms),
      {
        includeTask: firstReport || currentTaskChanged,
        includeReasoning: firstReport || reasoningChanged,
        headerMode: 'minimal',
      },
    );
  }

  private isLowValueTask(task?: string): boolean {
    if (!task) return true;
    const normalized = task.toLowerCase();
    if (!normalized.trim()) return true;
    if (
      normalized.includes('mailbox.status')
      || normalized.includes('mailbox.list')
      || normalized.includes('mailbox.read')
      || normalized.includes('mailbox.ack')
    ) {
      return true;
    }
    if ([
      '处理中',
      '处理中…',
      '处理中...',
      '执行中',
      '等待中',
      '继续处理',
    ].includes(normalized)) {
      return true;
    }
    // suppress generic filesystem peeks that are high-frequency and low-value for user progress
    if (/^\s*cat\b/.test(normalized)) {
      return true;
    }
    return false;
  }

  private extractCommandFromParams(params?: string): string {
    if (!params || params.trim().length === 0) return '';
    try {
      const parsed = JSON.parse(params) as Record<string, unknown>;
      if (typeof parsed.cmd === 'string') return parsed.cmd.trim();
      if (typeof parsed.command === 'string') return parsed.command.trim();
      if (typeof parsed.input === 'string') return parsed.input.trim();
      return '';
    } catch {
      return params;
    }
  }

  private isLowValueToolCall(tool: ToolCallRecord): boolean {
    const toolName = (tool.toolName || '').trim().toLowerCase();
    if (!toolName) return true;
    if (ProgressMonitor.LOW_VALUE_TOOLS.has(toolName)) return true;

    if (toolName === 'exec_command' || toolName === 'shell.exec') {
      const command = this.extractCommandFromParams(tool.params).toLowerCase();
      if (!command.trim()) return true;
      if (/^\s*cat\b/.test(command)) return true;
      if (/^\s*(ls|pwd|head|tail|sed\s+-n|wc|stat)\b/.test(command)) return true;
    }

    return false;
  }

  private buildReportKey(p: SessionProgress): string {
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
    return buildReportKeyUtil(data, this.latestStepSummary.get(p.sessionId));
  }

  private shouldEmitHeartbeat(p: SessionProgress, now: number): boolean {
    if (p.status !== 'running') return false;
    const lastReportTime = p.lastReportTime ?? 0;
    if (now - lastReportTime < this.config.intervalMs) return false;
    return now - p.lastUpdateTime >= this.config.intervalMs;
  }

  private findPendingMeaningfulTool(p: SessionProgress): ToolCallRecord | undefined {
    return [...p.toolCallHistory]
      .reverse()
      .find((tool) => !this.isLowValueToolCall(tool) && tool.success === undefined && !tool.result && !tool.error);
  }

  private buildHeartbeatSummary(p: SessionProgress, now: number, pendingTool: ToolCallRecord): string {
    const waitingMs = Math.max(0, now - p.lastUpdateTime);
    const localTime = new Date();
    const hh = String(localTime.getHours()).padStart(2, '0');
    const mm = String(localTime.getMinutes()).padStart(2, '0');
    const lines = [`📊 ${hh}:${mm} | 执行中`];
    const toolName = resolveToolDisplayName(pendingTool.toolName?.trim() || '工具', pendingTool.params);
    lines.push(`⏳ ${this.formatElapsed(waitingMs)} 无新事件，当前等待工具 ${toolName} 返回`);

    const contextLine = buildContextUsageLine({
      contextUsagePercent: p.contextUsagePercent,
      estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
      maxInputTokens: p.maxInputTokens,
    });
    if (contextLine) {
      lines.push(contextLine);
    }

    return lines.join('\n');
  }

  /**
   * 格式化时间
   */
  private formatElapsed(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * 获取指定 session 的进度
   */
  getProgress(sessionId: string): SessionProgress | undefined {
    return this.sessionProgress.get(sessionId);
  }

  /**
   * 清理已完成的 session 进度
   */
  cleanupCompleted(): void {
    for (const [sessionId, progress] of this.sessionProgress.entries()) {
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'idle') {
        // 保留最近 5 分钟的完成记录
        if (Date.now() - progress.lastUpdateTime > 5 * 60 * 1000) {
          this.sessionProgress.delete(sessionId);
        }
      }
    }
  }

  /**
   * 手动触发进度报告（用于用户请求时）
   */
  async getProgressReport(sessionId: string): Promise<ProgressReport | null> {
    const progress = this.sessionProgress.get(sessionId);
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
