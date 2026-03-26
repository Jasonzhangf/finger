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

  private snippetLimitForTool(toolName?: string): number {
    if (toolName === 'update_plan') return 12_000;
    return 200;
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
      ['turn_start', 'turn_complete', 'tool_call', 'tool_result', 'tool_error', 'model_round', 'agent_runtime_status', 'agent_step_completed', 'agent_runtime_dispatch'],
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
    const agentId = event.agentId || 'unknown';

    // 获取或创建进度记录
    let progress = this.sessionProgress.get(sessionId);
    if (!progress) {
      const now = Date.now();
      progress = {
        sessionId,
        agentId,
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
    progress.agentId = agentId;

    switch (eventType) {
      case 'turn_start':
        progress.status = 'running';
        if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
          progress.latestReasoning = event.payload.reasoning.slice(0, 120);
        }
        break;
      case 'turn_complete':
        if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
          progress.latestReasoning = event.payload.reasoning.slice(0, 120);
        }
        break;
      case 'tool_call':
        progress.toolCallsCount++;
        this.recordToolCall(progress, event.toolId, event.toolName, event.payload?.input);
        break;
      case 'tool_result':
        this.recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, event.payload?.output, undefined, true);
        if (event.toolName) {
          const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
          progress.currentTask = `${resolved} → ✅`;
        }
        break;
      case 'tool_error':
        this.recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, undefined, event.payload?.error, false);
        if (event.toolName) {
          const resolved = resolveToolDisplayName(event.toolName, event.payload?.input);
          progress.currentTask = `${resolved} → ❌`;
        }
        break;
      case 'model_round':
        progress.modelRoundsCount++;
        if (event.payload?.reasoning_count) {
          progress.reasoningCount += event.payload.reasoning_count;
        }
        if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
          progress.latestReasoning = event.payload.reasoning.slice(0, 120);
        }
        {
          const contextUsagePercentRaw = typeof event.payload?.contextUsagePercent === 'number'
            ? event.payload.contextUsagePercent
            : typeof event.payload?.context_usage_percent === 'number'
              ? event.payload.context_usage_percent
              : undefined;
          const estimatedTokensRaw = typeof event.payload?.estimatedTokensInContextWindow === 'number'
            ? event.payload.estimatedTokensInContextWindow
            : typeof event.payload?.estimated_tokens_in_context_window === 'number'
              ? event.payload.estimated_tokens_in_context_window
              : undefined;
          const maxInputTokensRaw = typeof event.payload?.maxInputTokens === 'number'
            ? event.payload.maxInputTokens
            : typeof event.payload?.max_input_tokens === 'number'
              ? event.payload.max_input_tokens
              : undefined;

          if (typeof contextUsagePercentRaw === 'number' && Number.isFinite(contextUsagePercentRaw)) {
            progress.contextUsagePercent = Math.max(0, Math.floor(contextUsagePercentRaw));
          }
          if (typeof estimatedTokensRaw === 'number' && Number.isFinite(estimatedTokensRaw)) {
            progress.estimatedTokensInContextWindow = Math.max(0, Math.floor(estimatedTokensRaw));
          }
          if (typeof maxInputTokensRaw === 'number' && Number.isFinite(maxInputTokensRaw)) {
            progress.maxInputTokens = Math.max(0, Math.floor(maxInputTokensRaw));
          }
        }
        break;
      case 'agent_runtime_status':
        const status = event.payload?.status;
        if (status === 'completed') {
          progress.status = 'completed';
        } else if (status === 'failed') {
          progress.status = 'failed';
        } else if (status === 'idle') {
          progress.status = 'idle';
        }
        if (event.payload?.summary) {
          progress.currentTask = event.payload.summary;
        }
        break;
      case 'agent_runtime_dispatch':
        // Skip heartbeat/bootstrap dispatches only (system dispatch is now business-critical).
        const source = event.payload?.sourceAgentId || (event as any).sourceAgentId || '';
        if (source.includes('heartbeat') || source.includes('bootstrap')) {
          break;
        }
        // Skip self-dispatch (system agent dispatching to itself)
        const target = event.payload?.targetAgentId;
        if (target && target === progress.agentId) {
          break;
        }
        if (target) {
          const status = event.payload?.status || 'queued';
          progress.currentTask = `派发 ${target} (${status})`;
          if (status === 'failed') progress.status = 'failed';
        }
        break;
      case 'agent_step_completed':
        progress.modelRoundsCount++;
        const payload = event.payload as { round?: number; thought?: string; action?: string; observation?: string };
        const parts: string[] = [];
        if (payload.thought) parts.push(payload.thought);
        if (payload.action) parts.push(payload.action);
        if (payload.thought) {
          progress.latestReasoning = payload.thought.slice(0, 120);
        }
        this.latestStepSummary.set(sessionId, parts.join(' → ') || `步骤 ${payload.round ?? '?'}`);
        progress.currentTask = this.latestStepSummary.get(sessionId);
        break;
    }

    progress.elapsedMs = Date.now() - progress.startTime;
  }

  private recordToolCall(progress: SessionProgress, toolId?: string, toolName?: string, input?: unknown): void {
    const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
    progress.toolSeqCounter = nextSeq;
    const record: ToolCallRecord = {
      seq: nextSeq,
      toolId,
      toolName: toolName || 'unknown',
      params: this.safeSnippet(input, this.snippetLimitForTool(toolName)),
      timestamp: Date.now(),
    };
    progress.toolCallHistory.push(record);
    if (progress.toolCallHistory.length > 10) {
      progress.toolCallHistory.shift();
    }
  }

 private recordToolResult(
   progress: SessionProgress,
   toolId?: string,
   toolName?: string,
   input?: unknown,
   output?: unknown,
   error?: string,
   success?: boolean,
  ): void {
    // 先按 toolId 查找
    let existing = toolId
      ? progress.toolCallHistory.find(t => t.toolId === toolId && !t.result && !t.error)
      : undefined;

    // 如果按 toolId 找不到，按 toolName 查找最近的未完成记录
    if (!existing && toolName) {
      const inputSnippet = this.safeSnippet(input, this.snippetLimitForTool(toolName));
      // 从后往前找最后一个未完成的同名工具
      for (let i = progress.toolCallHistory.length - 1; i >= 0; i--) {
        const t = progress.toolCallHistory[i];
        if (
          t.toolName === toolName
          && !t.result
          && !t.error
          && (inputSnippet === undefined || t.params === inputSnippet)
        ) {
          existing = t;
          break;
        }
      }

      // 若带参数匹配失败，再降级到同名匹配
      if (!existing) {
        for (let i = progress.toolCallHistory.length - 1; i >= 0; i--) {
          const t = progress.toolCallHistory[i];
          if (t.toolName === toolName && !t.result && !t.error) {
            existing = t;
            break;
          }
        }
      }
    }

    let record: ToolCallRecord;
    if (existing) {
      record = existing;
      if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) {
        const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
        progress.toolSeqCounter = nextSeq;
        record.seq = nextSeq;
      }
    } else {
      const nextSeq = (progress.toolSeqCounter ?? 0) + 1;
      progress.toolSeqCounter = nextSeq;
      record = {
        seq: nextSeq,
        toolId,
        toolName: toolName || 'unknown',
        params: this.safeSnippet(input, this.snippetLimitForTool(toolName)),
        timestamp: Date.now(),
      };
    }
    record.result = output !== undefined ? this.safeSnippet(output) : record.result;
    record.error = error ? this.safeSnippet(error) : record.error;
    record.success = success;
    if (!existing) {
      progress.toolCallHistory.push(record);
    }
    if (progress.toolCallHistory.length > 10) {
      progress.toolCallHistory.shift();
    }
    const displayName = resolveToolDisplayName(record.toolName, record.params);
    progress.currentTask = `${displayName} → ${success ? '✅' : '❌'}`;
  }

  private safeSnippet(value: unknown, limit = 200): string | undefined {
    if (value === undefined || value === null) return undefined;
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > limit ? text.slice(0, limit) + '...' : text;
    } catch {
      const text = String(value);
      return text.length > limit ? text.slice(0, limit) + '...' : text;
    }
  }

  /**
   * 生成进度报告并通过 callbacks 推送
   */
  private async generateProgressReport(): Promise<void> {
    if (!this.config.progressUpdates) return;

    // 获取所有活跃的 session
    const activeProgress = Array.from(this.sessionProgress.values())
      .filter(p => p.status === 'running' && p.elapsedMs > 0);

    if (activeProgress.length === 0) return;

    log.debug(`[ProgressMonitor] Generating progress report for ${activeProgress.length} sessions`);

    // 为每个活跃 session 生成并推送进度报告
    for (const p of activeProgress) {
      const now = Date.now();
      // Keep elapsed clock moving even when no new events are emitted.
      p.elapsedMs = now - p.startTime;
      const heartbeatDue = !p.lastReportTime || (now - p.lastReportTime) >= this.config.intervalMs;
      const reportKey = this.buildReportKey(p);
      if (p.lastReportKey === reportKey && !heartbeatDue) {
        continue;
      }

      // 仅发送新增工具调用（避免重复）
      const lastReportedSeq = p.lastReportedToolSeq ?? 0;
      const newToolCalls = p.toolCallHistory.filter((tool) => (tool.seq ?? 0) > lastReportedSeq);
      const currentTaskChanged = (p.currentTask ?? '') !== (p.lastReportedCurrentTask ?? '');
      const reasoningChanged = (p.latestReasoning ?? '') !== (p.lastReportedReasoning ?? '');
      const contextChanged = (p.contextUsagePercent ?? -1) !== (p.lastReportedContextUsagePercent ?? -1)
        || (p.estimatedTokensInContextWindow ?? -1) !== (p.lastReportedEstimatedTokensInContextWindow ?? -1)
        || (p.maxInputTokens ?? -1) !== (p.lastReportedMaxInputTokens ?? -1);
      if (newToolCalls.length === 0 && !currentTaskChanged && !reasoningChanged && !contextChanged && !heartbeatDue) {
        continue;
      }

      const report: ProgressReport = {
        type: 'progress_report',
        timestamp: new Date().toISOString(),
        sessionId: p.sessionId,
        agentId: p.agentId,
        progress: p,
        summary: this.buildSingleProgressSummary(p, newToolCalls),
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

  private buildReportKey(p: SessionProgress): string {
    const data: SessionProgressData = {
      agentId: p.agentId,
      status: p.status,
      currentTask: p.currentTask,
      elapsedMs: p.elapsedMs,
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
