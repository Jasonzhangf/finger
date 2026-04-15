 import { loadTeamStatusStore } from '../../common/team-status-state.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { logger } from '../../core/logger.js';
import {
  classifyToolCall,
  extractTargetFile,
  type SessionProgressData,
} from '../../server/modules/progress-monitor-utils.js';
import {
  buildCompactSummary,
  buildReportKey as buildReportKeyUtil,
  resolveToolDisplayName,
} from '../../server/modules/progress-monitor-reporting.js';
import {
  buildHeartbeatSummary,
  findPendingMeaningfulTool,
  formatElapsed,
  isLowValueToolCall,
  shouldEmitHeartbeat,
} from '../../server/modules/progress-monitor-helpers.js';
import {
  DEFAULT_PROGRESS_MONITOR_CONFIG,
  loadProgressMonitorConfig,
} from '../../server/modules/progress-monitor-config.js';
import type {
  ProgressRoundDigest,
  ProgressRoundDigestItem,
  ProgressMonitorCallbacks,
  ProgressMonitorConfig,
  ProgressReport,
  SessionProgress,
  ToolCallRecord,
} from '../../server/modules/progress-monitor-types.js';
import {
  handleAgentRuntimeDispatch,
  handleAgentRuntimeStatus,
  handleAgentStepCompleted,
  handleModelRound,
  handleSessionCompressedEvent,
  handleSessionTopicShiftEvent,
  handleSystemNoticeEvent,
  handleToolCallEvent,
  handleToolErrorEvent,
  handleToolResultEvent,
  handleTurnComplete,
  handleTurnStart,
  handleUserDecisionReceivedEvent,
  handleWaitingForUserEvent,
  snippetLimitForTool,
} from '../../server/modules/progress-monitor-event-handlers.js';
import { getExecutionLifecycleState, type ExecutionLifecycleState } from '../../server/modules/execution-lifecycle.js';

const log = logger.module('ProgressMonitor');
import { progressStore } from '../../server/modules/progress/index.js';
export type {
  ProgressMonitorCallbacks,
  ProgressMonitorConfig,
  ProgressReport,
  SessionProgress,
  ToolCallRecord,
} from '../../server/modules/progress-monitor-types.js';

export class ProgressMonitor {
  private timer: NodeJS.Timeout | null = null;
  private reportGenerationInFlight: Promise<void> | null = null;
  private config: Required<ProgressMonitorConfig>;
  private lastConfigReloadAt = 0;
  private configReloadInFlight: Promise<void> | null = null;
  private static readonly CONFIG_RELOAD_COOLDOWN_MS = 5_000;
  // key: `${sessionId}::${agentId}`
  private sessionProgress = new Map<string, SessionProgress>();
  private _stopCleanup: (() => void) | null = null;
  private _cleanupTimer: NodeJS.Timeout | null = null;
  // key: `${sessionId}::${agentId}`
  private latestStepSummary = new Map<string, string>();
  // key: sessionId
  private sessionContextSnapshot = new Map<string, {
    contextUsagePercent?: number;
    estimatedTokensInContextWindow?: number;
    maxInputTokens?: number;
    contextBreakdown?: SessionProgress['contextBreakdown'];
    lastContextEvent?: string;
    updatedAt: number;
  }>();

  private static readonly LOW_VALUE_TOOLS = new Set([
    'mailbox.status',
    'mailbox.list',
    'mailbox.read',
    'mailbox.ack',
  ]);
  private static readonly REPORT_DELIVERY_TIMEOUT_MS = 15_000;
  private static readonly STALL_HEARTBEAT_FACTOR_NO_PENDING = 2;
  private static readonly MAX_RECENT_ROUNDS = 6;


  /**
   * 清除指定 session 的 recentRounds（用于话题切换时清理旧 digest）
   */
  clearRecentRounds(sessionId: string): void {
    const entries = this.getProgressEntriesBySession(sessionId);
    for (const [, progress] of entries) {
      progress.recentRounds = [];
      progress.progressRoundSeq = 0;
    }
    log.info('[ProgressMonitor] Cleared recentRounds for session', { sessionId });
  }
  private buildProgressKey(sessionId: string, agentId: string): string {
    return `${sessionId}::${agentId}`;
  }

  private hasPendingToolCalls(progress: SessionProgress): boolean {
    return progress.toolCallHistory.some((tool) => {
      if (tool.success === true || tool.success === false) return false;
      if (tool.result || tool.error) return false;
      return true;
    });
  }

  private isToolRecordCompleted(tool: ToolCallRecord): boolean {
    return tool.success === true
      || tool.success === false
      || Boolean(tool.result)
      || Boolean(tool.error);
  }

  private advanceReportedToolCursor(progress: SessionProgress, newToolCalls: ToolCallRecord[]): void {
    if (!Array.isArray(newToolCalls) || newToolCalls.length === 0) return;
    const currentCursor = progress.lastReportedToolSeq ?? 0;
    const unresolvedSeqs = progress.toolCallHistory
      .filter((tool) => !this.isToolRecordCompleted(tool))
      .map((tool) => (typeof tool.seq === 'number' && Number.isFinite(tool.seq) ? tool.seq : 0))
      .filter((seq) => seq > currentCursor)
      .sort((a, b) => a - b);

    let barrier = Number.POSITIVE_INFINITY;
    if (unresolvedSeqs.length > 0) {
      barrier = unresolvedSeqs[0] - 1;
    }
    const candidate = newToolCalls
      .map((tool) => (typeof tool.seq === 'number' && Number.isFinite(tool.seq) ? tool.seq : 0))
      .filter((seq) => seq > currentCursor && seq <= barrier)
      .reduce((max, seq) => (seq > max ? seq : max), currentCursor);
    if (candidate > currentCursor) {
      progress.lastReportedToolSeq = candidate;
    }
  }

  private resolveExecutionLifecycle(sessionId: string): ExecutionLifecycleState | null {
    try {
      return getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    } catch (error) {
      log.debug('[ProgressMonitor] Failed to resolve execution lifecycle', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private resolveWaitLayer(
    p: SessionProgress,
    pendingTool: ToolCallRecord | undefined,
    stalled: boolean,
    now: number,
  ): {
    waitLayer?: 'external' | 'internal';
    waitKind?: 'provider' | 'tool' | 'user' | 'unknown';
    waitDetail?: string;
    lifecycleStage?: string;
    lifecycleDetail?: string;
    lifecycleAgeMs?: number;
    lifecycleFinalState?: boolean;
  } {
    const lifecycle = this.resolveExecutionLifecycle(p.sessionId);
    const stage = lifecycle?.stage;
    const detail = lifecycle?.substage || lifecycle?.detail;
    const lifecycleTransitionMs = lifecycle?.lastTransitionAt
      ? Date.parse(lifecycle.lastTransitionAt)
      : Number.NaN;
    const lifecycleAgeMs = Number.isFinite(lifecycleTransitionMs)
      ? Math.max(0, now - lifecycleTransitionMs)
      : undefined;
    const lifecycleTimeoutMs = typeof lifecycle?.timeoutMs === 'number' && Number.isFinite(lifecycle.timeoutMs)
      ? Math.max(0, Math.floor(lifecycle.timeoutMs))
      : undefined;

    const baseLifecycle = {
      ...(stage ? { lifecycleStage: stage } : {}),
      ...(detail ? { lifecycleDetail: detail } : {}),
      ...(typeof lifecycleAgeMs === 'number' ? { lifecycleAgeMs } : {}),
    };

    // 终态处理：completed/failed/interrupted 不应该报告"疑似卡住"
    if (stage === 'completed' || stage === 'failed' || stage === 'interrupted') {
      return {
        ...baseLifecycle,
        waitLayer: 'internal',
        waitKind: 'unknown',
        waitDetail: detail || stage,
        lifecycleFinalState: true,
      };
    }

    if (stage === 'waiting_model') {
      return {
        ...baseLifecycle,
        waitLayer: 'external',
        waitKind: 'provider',
        ...(detail ? { waitDetail: detail } : {}),
      };
    }
    if (stage === 'waiting_tool') {
      return {
        ...baseLifecycle,
        waitLayer: 'external',
        waitKind: 'tool',
        ...(detail ? { waitDetail: detail } : {}),
      };
    }
    if (stage === 'waiting_user') {
      return {
        ...baseLifecycle,
        waitLayer: 'external',
        waitKind: 'user',
        ...(detail ? { waitDetail: detail } : {}),
      };
    }
    if (stage === 'retrying') {
      const retryCount = typeof lifecycle?.retryCount === 'number' && Number.isFinite(lifecycle.retryCount)
        ? Math.max(0, Math.floor(lifecycle.retryCount))
        : 0;
      const retryLabel = `attempt=${retryCount + 1}`;
      const timeoutLabel = lifecycleTimeoutMs && lifecycleTimeoutMs > 0
        ? `timeout=${Math.floor(lifecycleTimeoutMs / 1000)}s`
        : '';
      const ageLabel = typeof lifecycleAgeMs === 'number' ? `age=${formatElapsed(lifecycleAgeMs)}` : '';
      const baseDetail = [detail, retryLabel, timeoutLabel, ageLabel]
        .filter((item) => typeof item === 'string' && item.trim().length > 0)
        .join(' · ');
      const staleBeyondTimeout = lifecycleTimeoutMs !== undefined
        && typeof lifecycleAgeMs === 'number'
        && lifecycleAgeMs > lifecycleTimeoutMs + 2 * this.config.intervalMs;
      if (staleBeyondTimeout) {
        return {
          ...baseLifecycle,
          waitLayer: 'internal',
          waitKind: 'unknown',
          waitDetail: baseDetail.length > 0 ? `retry watchdog exceeded (${baseDetail})` : 'retry watchdog exceeded',
        };
      }
      return {
        ...baseLifecycle,
        waitLayer: 'external',
        waitKind: 'provider',
        ...(baseDetail.length > 0 ? { waitDetail: `retrying (${baseDetail})` } : {}),
      };
    }
    if (pendingTool) {
      const toolName = resolveToolDisplayName(pendingTool.toolName?.trim() || '工具', pendingTool.params);
      return {
        ...baseLifecycle,
        waitLayer: 'external',
        waitKind: 'tool',
        waitDetail: toolName,
      };
    }
    if (stalled) {
      return {
        ...baseLifecycle,
        waitLayer: 'internal',
        waitKind: 'unknown',
      };
    }
    return baseLifecycle;
  }

  private summarizeRoundTool(tool: ToolCallRecord): ProgressRoundDigestItem {
    const displayName = resolveToolDisplayName(tool.toolName, tool.params);
    const category = classifyToolCall(tool.toolName, tool.params);
    const file = extractTargetFile(tool.toolName, tool.params) || undefined;
    return {
      toolName: tool.toolName,
      displayName,
      category,
      ...(file ? { file } : {}),
      ...(typeof tool.success === 'boolean' ? { success: tool.success } : {}),
    };
  }

  private buildRoundSummary(items: ProgressRoundDigestItem[]): string {
    if (!Array.isArray(items) || items.length === 0) return '无工具明细';
    return items
      .slice(0, 4)
      .map((item) => {
        const status = item.success === false ? '❌' : item.success === true ? '✅' : '⏳';
        const filePart = item.file ? ` @${item.file}` : '';
        return `${status} ${item.displayName}${filePart}`;
      })
      .join('；');
  }

  private createRoundDigest(
    progress: SessionProgress,
    tools: ToolCallRecord[],
    timestamp = Date.now(),
  ): ProgressRoundDigest | undefined {
    if (!Array.isArray(tools) || tools.length === 0) return;
    const items = tools.map((tool) => this.summarizeRoundTool(tool));
    const successCount = tools.filter((tool) => tool.success === true).length;
    const failureCount = tools.filter((tool) => tool.success === false).length;
    const seq = (progress.progressRoundSeq ?? 0) + 1;
    return {
      seq,
      timestamp,
      successCount,
      failureCount,
      summary: this.buildRoundSummary(items),
      items: items.slice(0, 8),
    };
  }

  private appendRoundDigest(progress: SessionProgress, digest: ProgressRoundDigest): void {
    progress.progressRoundSeq = digest.seq;
    const rounds = Array.isArray(progress.recentRounds) ? [...progress.recentRounds] : [];
    rounds.push(digest);
    if (rounds.length > ProgressMonitor.MAX_RECENT_ROUNDS) {
      rounds.splice(0, rounds.length - ProgressMonitor.MAX_RECENT_ROUNDS);
    }
    progress.recentRounds = rounds;
  }

  private buildRecentRoundsSection(progress: SessionProgress, previewDigest?: ProgressRoundDigest): string[] {
    const rounds = Array.isArray(progress.recentRounds) ? [...progress.recentRounds] : [];
    if (previewDigest) {
      rounds.push(previewDigest);
    }
    if (rounds.length === 0) return [];
    const lines: string[] = ['🕘 最近轮次:'];
    
    // 去重：相邻两轮如果 summary 相同，只显示一次
    const uniqueRounds: ProgressRoundDigest[] = [];
    for (const round of rounds.slice(-3)) {
      const lastRound = uniqueRounds[uniqueRounds.length - 1];
      if (!lastRound || lastRound.summary !== round.summary) {
        uniqueRounds.push(round);
      }
    }
    
    for (const round of uniqueRounds) {
      const statusIcon = round.failureCount > 0 ? '❌' : round.successCount > 0 ? '✅' : '⏳';
      const truncatedSummary = round.summary.length > 60 
        ? round.summary.slice(0, 57) + '...' 
        : round.summary;
      lines.push(`  ${statusIcon} ${truncatedSummary}`);
    }
    return lines;
  }

  private buildStateLines(
    p: SessionProgress,
    now: number,
    waitInfo: {
      waitLayer?: 'external' | 'internal';
      waitKind?: 'provider' | 'tool' | 'user' | 'unknown';
      waitDetail?: string;
      lifecycleStage?: string;
      lifecycleDetail?: string;
      lifecycleAgeMs?: number;
    },
  ): string[] {
    const lines: string[] = [];
    if (waitInfo.lifecycleStage) {
      const age = typeof waitInfo.lifecycleAgeMs === 'number' && Number.isFinite(waitInfo.lifecycleAgeMs)
        ? ` · 持续 ${formatElapsed(waitInfo.lifecycleAgeMs)}`
        : '';
      lines.push(`🧠 内部状态: ${waitInfo.lifecycleStage}${waitInfo.lifecycleDetail ? ` · ${waitInfo.lifecycleDetail}` : ''}${age}`);
    }
    if (waitInfo.waitLayer === 'external') {
      const kind = waitInfo.waitKind ?? 'unknown';
      const zhKind = kind === 'provider'
        ? 'provider'
        : kind === 'tool'
          ? '工具'
          : kind === 'user'
            ? '用户'
            : '外部';
      lines.push(`🌐 外部状态: 等待${zhKind}${waitInfo.waitDetail ? ` · ${waitInfo.waitDetail}` : ''}`);
    } else if (waitInfo.waitLayer === 'internal') {
      lines.push(`⚙️ 内部状态: 等待内部推进${waitInfo.waitDetail ? ` · ${waitInfo.waitDetail}` : ''}`);
    } else {
      const idleFor = Math.max(0, now - p.lastUpdateTime);
      lines.push(`⚙️ 内部状态: 执行循环中 · 最近事件 ${formatElapsed(idleFor)} 前`);
    }
    return lines;
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

  private normalizeNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.floor(parsed);
    }
    return undefined;
  }

  private normalizeContextBreakdownFromPayload(payload: Record<string, unknown>): SessionProgress['contextBreakdown'] | undefined {
    const raw = (typeof payload.contextBreakdown === 'object' && payload.contextBreakdown !== null)
      ? payload.contextBreakdown as Record<string, unknown>
      : (typeof payload.context_breakdown === 'object' && payload.context_breakdown !== null)
        ? payload.context_breakdown as Record<string, unknown>
        : undefined;
    if (!raw) return undefined;

    const normalized: NonNullable<SessionProgress['contextBreakdown']> = {};
    const setNumeric = (targetKey: keyof NonNullable<SessionProgress['contextBreakdown']>, ...sourceKeys: string[]) => {
      for (const key of sourceKeys) {
        const num = this.normalizeNumber(raw[key]);
        if (num !== undefined && num >= 0) {
          (normalized as Record<string, unknown>)[targetKey as string] = Math.max(0, num);
          return;
        }
      }
    };

    setNumeric('historyContextTokens', 'historyContextTokens', 'history_context_tokens');
    setNumeric('historyCurrentTokens', 'historyCurrentTokens', 'history_current_tokens');
    setNumeric('historyTotalTokens', 'historyTotalTokens', 'history_total_tokens');
    setNumeric('historyContextMessages', 'historyContextMessages', 'history_context_messages');
    setNumeric('historyCurrentMessages', 'historyCurrentMessages', 'history_current_messages');
    setNumeric('systemPromptTokens', 'systemPromptTokens', 'system_prompt_tokens');
    setNumeric('developerPromptTokens', 'developerPromptTokens', 'developer_prompt_tokens');
    setNumeric('userInstructionsTokens', 'userInstructionsTokens', 'user_instructions_tokens');
    setNumeric('environmentContextTokens', 'environmentContextTokens', 'environment_context_tokens');
    setNumeric('turnContextTokens', 'turnContextTokens', 'turn_context_tokens');
    setNumeric('skillsTokens', 'skillsTokens', 'skills_tokens');
    setNumeric('mailboxTokens', 'mailboxTokens', 'mailbox_tokens');
    setNumeric('projectTokens', 'projectTokens', 'project_tokens');
    setNumeric('flowTokens', 'flowTokens', 'flow_tokens');
    setNumeric('contextSlotsTokens', 'contextSlotsTokens', 'context_slots_tokens');
    setNumeric('inputTextTokens', 'inputTextTokens', 'input_text_tokens');
    setNumeric('inputMediaTokens', 'inputMediaTokens', 'input_media_tokens');
    setNumeric('inputMediaCount', 'inputMediaCount', 'input_media_count');
    setNumeric('inputTotalTokens', 'inputTotalTokens', 'input_total_tokens');
    setNumeric('toolsSchemaTokens', 'toolsSchemaTokens', 'tools_schema_tokens');
    setNumeric('toolExecutionTokens', 'toolExecutionTokens', 'tool_execution_tokens');
    setNumeric('contextLedgerConfigTokens', 'contextLedgerConfigTokens', 'context_ledger_config_tokens');
    setNumeric('responsesConfigTokens', 'responsesConfigTokens', 'responses_config_tokens');
    setNumeric('totalKnownTokens', 'totalKnownTokens', 'total_known_tokens');

    if (typeof raw.source === 'string' && raw.source.trim().length > 0) {
      normalized.source = raw.source.trim();
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  private extractContextSnapshotFromEvent(event: any): {
    contextUsagePercent?: number;
    estimatedTokensInContextWindow?: number;
    maxInputTokens?: number;
    contextBreakdown?: SessionProgress['contextBreakdown'];
    lastContextEvent?: string;
  } | null {
    const payload = event?.payload && typeof event.payload === 'object'
      ? event.payload as Record<string, unknown>
      : undefined;
    if (!payload) return null;

    const contextUsagePercent = this.normalizeNumber(payload.contextUsagePercent ?? payload.context_usage_percent);
    const estimatedTokensInContextWindow = this.normalizeNumber(
      payload.estimatedTokensInContextWindow
      ?? payload.estimated_tokens_in_context_window
      ?? payload.inputTokens
      ?? payload.input_tokens
      ?? payload.totalTokens
      ?? payload.total_tokens,
    );
    const maxInputTokens = this.normalizeNumber(
      payload.maxInputTokens
      ?? payload.max_input_tokens
      ?? payload.modelContextWindow
      ?? payload.model_context_window,
    );
    const contextBreakdown = this.normalizeContextBreakdownFromPayload(payload);
    const lastContextEvent = typeof payload.source === 'string' && payload.source.trim().length > 0
      ? payload.source.trim()
      : undefined;

    const derivedEstimated = estimatedTokensInContextWindow
      ?? (contextBreakdown && typeof contextBreakdown.totalKnownTokens === 'number'
        ? contextBreakdown.totalKnownTokens
        : undefined);

    if (
      contextUsagePercent === undefined
      && derivedEstimated === undefined
      && maxInputTokens === undefined
      && !contextBreakdown
      && !lastContextEvent
    ) {
      return null;
    }

    return {
      ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
      ...(derivedEstimated !== undefined ? { estimatedTokensInContextWindow: Math.max(0, derivedEstimated) } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens: Math.max(1, maxInputTokens) } : {}),
      ...(contextBreakdown ? { contextBreakdown } : {}),
      ...(lastContextEvent ? { lastContextEvent } : {}),
    };
  }

  private mergeSessionContextSnapshot(
    sessionId: string,
    snapshot: {
      contextUsagePercent?: number;
      estimatedTokensInContextWindow?: number;
      maxInputTokens?: number;
      contextBreakdown?: SessionProgress['contextBreakdown'];
      lastContextEvent?: string;
    },
  ): void {
    const prev = this.sessionContextSnapshot.get(sessionId);
    this.sessionContextSnapshot.set(sessionId, {
      contextUsagePercent: snapshot.contextUsagePercent ?? prev?.contextUsagePercent,
      estimatedTokensInContextWindow: snapshot.estimatedTokensInContextWindow ?? prev?.estimatedTokensInContextWindow,
      maxInputTokens: snapshot.maxInputTokens ?? prev?.maxInputTokens,
      contextBreakdown: snapshot.contextBreakdown ?? prev?.contextBreakdown,
      lastContextEvent: snapshot.lastContextEvent ?? prev?.lastContextEvent,
      updatedAt: Date.now(),
    });
  }

  private applyExtractedContextSnapshot(
    progress: SessionProgress,
    snapshot: {
      contextUsagePercent?: number;
      estimatedTokensInContextWindow?: number;
      maxInputTokens?: number;
      contextBreakdown?: SessionProgress['contextBreakdown'];
      lastContextEvent?: string;
    },
  ): void {
    if (snapshot.contextUsagePercent !== undefined) {
      progress.contextUsagePercent = snapshot.contextUsagePercent;
    }
    if (snapshot.estimatedTokensInContextWindow !== undefined) {
      progress.estimatedTokensInContextWindow = snapshot.estimatedTokensInContextWindow;
    }
    if (snapshot.maxInputTokens !== undefined) {
      progress.maxInputTokens = snapshot.maxInputTokens;
    }
    if (snapshot.contextBreakdown) {
      progress.contextBreakdown = { ...snapshot.contextBreakdown };
    }
    if (snapshot.lastContextEvent) {
      progress.lastContextEvent = snapshot.lastContextEvent;
    }
  }

  private applySessionContextSnapshot(progress: SessionProgress): void {
    const snapshot = this.sessionContextSnapshot.get(progress.sessionId);
    if (!snapshot) return;

    if (progress.contextUsagePercent === undefined && snapshot.contextUsagePercent !== undefined) {
      progress.contextUsagePercent = snapshot.contextUsagePercent;
    }
    if (progress.estimatedTokensInContextWindow === undefined && snapshot.estimatedTokensInContextWindow !== undefined) {
      progress.estimatedTokensInContextWindow = snapshot.estimatedTokensInContextWindow;
    }
    if (progress.maxInputTokens === undefined && snapshot.maxInputTokens !== undefined) {
      progress.maxInputTokens = snapshot.maxInputTokens;
    }
    if (!progress.contextBreakdown && snapshot.contextBreakdown) {
      progress.contextBreakdown = { ...snapshot.contextBreakdown };
    }
    if (!progress.lastContextEvent && snapshot.lastContextEvent) {
      progress.lastContextEvent = snapshot.lastContextEvent;
    }
  }

  private cacheProgressContextSnapshot(progress: SessionProgress): void {
    if (
      progress.contextUsagePercent === undefined
      && progress.estimatedTokensInContextWindow === undefined
      && progress.maxInputTokens === undefined
      && !progress.contextBreakdown
      && !progress.lastContextEvent
    ) {
      return;
    }
    this.mergeSessionContextSnapshot(progress.sessionId, {
      ...(progress.contextUsagePercent !== undefined ? { contextUsagePercent: progress.contextUsagePercent } : {}),
      ...(progress.estimatedTokensInContextWindow !== undefined
        ? { estimatedTokensInContextWindow: progress.estimatedTokensInContextWindow }
        : {}),
      ...(progress.maxInputTokens !== undefined ? { maxInputTokens: progress.maxInputTokens } : {}),
      ...(progress.contextBreakdown ? { contextBreakdown: progress.contextBreakdown } : {}),
      ...(progress.lastContextEvent ? { lastContextEvent: progress.lastContextEvent } : {}),
    });
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
      contextBreakdownMode: config?.contextBreakdownMode ?? DEFAULT_PROGRESS_MONITOR_CONFIG.contextBreakdownMode,
    };
    progressStore.setSessionManager(this.deps.sessionManager);
  }

  start(): void {
    if (this.timer) {
      log.warn('[ProgressMonitor] Already started');
      return;
    }

    if (!this.config.enabled) {
      log.info('[ProgressMonitor] Disabled by config');
      return;
    }

    void this.refreshConfigIfNeeded(true);

    log.info(`[ProgressMonitor] Starting with interval ${this.config.intervalMs}ms`);

    // 订阅事件来跟踪进度
    this.subscribeToEvents();
    this.subscribeToReasoningEvents();

    // 启动定期清理已完成 session 的进度记录
    this._cleanupTimer = setInterval(() => this.cleanupCompleted(), 5 * 60 * 1000);

    // 定期生成进度报告
    this.timer = setInterval(() => {
      this.scheduleProgressReportGeneration();
    }, this.config.intervalMs);
  }

  private restartReportTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.timer = setInterval(() => {
      this.scheduleProgressReportGeneration();
    }, this.config.intervalMs);
  }

  private scheduleProgressReportGeneration(): void {
    if (this.reportGenerationInFlight) return;
    this.reportGenerationInFlight = this.generateProgressReport()
      .catch((err) => {
        log.error('[ProgressMonitor] Error generating progress report:', err);
      })
      .finally(() => {
        this.reportGenerationInFlight = null;
      });
  }

  private async deliverProgressReport(report: ProgressReport): Promise<boolean> {
    if (!this.callbacks?.onProgressReport) return true;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`progress callback timeout after ${ProgressMonitor.REPORT_DELIVERY_TIMEOUT_MS}ms`));
      }, ProgressMonitor.REPORT_DELIVERY_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        Promise.resolve(this.callbacks.onProgressReport(report)),
        timeoutPromise,
      ]);
      return true;
    } catch (error) {
      log.warn('[ProgressMonitor] Failed to deliver progress report', {
        sessionId: report.sessionId,
        agentId: report.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refreshConfigIfNeeded(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastConfigReloadAt < ProgressMonitor.CONFIG_RELOAD_COOLDOWN_MS) {
      return;
    }
    if (this.configReloadInFlight) {
      await this.configReloadInFlight;
      return;
    }
    this.configReloadInFlight = (async () => {
      try {
        const loaded = await loadProgressMonitorConfig();
        const intervalChanged = loaded.intervalMs !== this.config.intervalMs;
        const modeChanged = loaded.contextBreakdownMode !== this.config.contextBreakdownMode;
        this.config = {
          ...this.config,
          intervalMs: loaded.intervalMs,
          enabled: loaded.enabled,
          progressUpdates: loaded.progressUpdates,
          contextBreakdownMode: loaded.contextBreakdownMode,
        };
        if (intervalChanged && this.timer) {
          this.restartReportTimer();
        }
        if (modeChanged) {
          log.info('[ProgressMonitor] contextBreakdownMode changed', {
            contextBreakdownMode: this.config.contextBreakdownMode,
          });
        }
      } catch (error) {
        log.warn('[ProgressMonitor] Failed to refresh config, keep current', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.lastConfigReloadAt = Date.now();
        this.configReloadInFlight = null;
      }
    })();
    await this.configReloadInFlight;
  }

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

  private subscribeToEvents(): void {
    const unsubscribe = this.eventBus.subscribeMultiple(
      [
        'turn_start',
        'turn_complete',
        'tool_call',
        'tool_result',
        'tool_error',
        'model_round',
        'system_notice',
        'session_compressed',
        'agent_runtime_status',
        'agent_step_completed',
        'agent_dispatch_queued',
        'agent_dispatch_started',
        'agent_dispatch_complete',
        'agent_dispatch_failed',
        'agent_dispatch_partial',
        'waiting_for_user',
        'user_decision_received',
      ],
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
          progress.lastUpdateTime = Date.now();
       }
     }
   });

    const prev = this._stopCleanup;
    this._stopCleanup = () => {
      unsubscribe();
      prev?.();
    };
  }

  private async handleEvent(event: any): Promise<void> {
    await this.refreshConfigIfNeeded();
    const sessionId = event.sessionId;
    if (!sessionId) return;

    const extractedSnapshot = this.extractContextSnapshotFromEvent(event);
    if (extractedSnapshot) {
      this.mergeSessionContextSnapshot(sessionId, extractedSnapshot);
    }

    const eventType = event.type;
    const incomingAgentId = this.parseEventAgentId(event);
    const now = Date.now();
    const sessionEntries = this.getProgressEntriesBySession(sessionId);
    if (extractedSnapshot && !incomingAgentId && sessionEntries.length > 0) {
      for (const [, entry] of sessionEntries) {
        this.applyExtractedContextSnapshot(entry, extractedSnapshot);
      }
    }
    // Session-level event without explicit agentId: update existing entries only.
    if (!incomingAgentId) {
      if (sessionEntries.length === 0) return;

      if (eventType === 'system_notice') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleSystemNoticeEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }

      if (eventType === 'turn_start') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleTurnStart(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }

      if (eventType === 'turn_complete') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleTurnComplete(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }

      if (eventType === 'session_compressed') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleSessionCompressedEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }

      if (eventType === 'session_topic_shift') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleSessionTopicShiftEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }
      if (eventType === 'waiting_for_user') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleWaitingForUserEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
        return;
      }

      if (eventType === 'user_decision_received') {
        for (const [, entry] of sessionEntries) {
          entry.lastUpdateTime = now;
          handleUserDecisionReceivedEvent(entry, event);
          entry.elapsedMs = now - entry.startTime;
          this.cacheProgressContextSnapshot(entry);
        }
      }
      return;
    }

    const progressKey = this.buildProgressKey(sessionId, incomingAgentId);
    if (extractedSnapshot && !this.sessionProgress.has(progressKey) && sessionEntries.length > 0) {
      // Attribution mismatch safeguard:
      // if context snapshot arrives with an unknown agentId but session already has active progress entries,
      // mirror snapshot into existing entries instead of dropping it.
      for (const [, entry] of sessionEntries) {
        this.applyExtractedContextSnapshot(entry, extractedSnapshot);
      }
    }
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
        contextUsageAddedTokens: 0,
        recentRounds: [],
        progressRoundSeq: 0,
      };
      this.applySessionContextSnapshot(progress);
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
      case 'session_compressed':
        handleSessionCompressedEvent(progress, event);
        break;
      case 'agent_runtime_status':
        handleAgentRuntimeStatus(progress, event);
        break;
     case 'agent_dispatch_queued':
     case 'agent_dispatch_started':
     case 'agent_dispatch_complete':
      case 'agent_dispatch_failed':
      case 'agent_dispatch_partial':
        handleAgentRuntimeDispatch(progress, event);
        break;
      case 'agent_step_completed':
        handleAgentStepCompleted(progress, event, this.latestStepSummary);
        break;
      case 'waiting_for_user':
        handleWaitingForUserEvent(progress, event);
        break;
      case 'user_decision_received':
        handleUserDecisionReceivedEvent(progress, event);
        break;
    }

    progress.elapsedMs = now - progress.startTime;
    this.cacheProgressContextSnapshot(progress);
  }

  private async generateProgressReport(): Promise<void> {
    await this.refreshConfigIfNeeded();
    if (!this.config.progressUpdates) return;


   // Get global team status for observability
   const teamStatusStore = loadTeamStatusStore();
   const teamStatus = Object.values(teamStatusStore.agents);
   const now = Date.now();
   // 获取所有活跃的 session；先按 startTime 刷新 elapsed，避免运行中但尚未回填 elapsedMs 的 session 被漏掉。
   const activeProgress = Array.from(this.sessionProgress.values())
     .filter((p) => {
        // 状态过滤：running/queued 且有活跃工具调用，或者有未完成的工具调用
        const hasActiveTools = p.toolCallHistory.some(t => !this.isToolRecordCompleted(t));
        const recentlyActiveTools = p.toolCallHistory.some(t => {
          const age = now - (t.timestamp ?? 0);
          return age < this.config.intervalMs * 2;
        });
        const isQueuedWithPending = false; // SessionProgress.status does not have 'queued' state

   // Debug log for team status
   log.info('[ProgressMonitor] Team status loaded:', {
     teamStatusCount: teamStatus.length,
     teamStatusAgents: teamStatus.map(a => a.agentId),
   });

        const isRunningOrRecentlyActive = p.status === 'running' || (p.status === 'idle' && recentlyActiveTools);
        if (!isRunningOrRecentlyActive) return false;
       p.elapsedMs = Math.max(0, now - p.startTime);
       return true;
     });

   if (activeProgress.length === 0) return;

    log.debug(`[ProgressMonitor] Generating progress report for ${activeProgress.length} active entries`);

    // 为每个活跃 session 生成并推送进度报告
    for (const p of activeProgress) {
      // 仅在 progressStore 缺失或上下文占用率不一致时输出诊断，避免在循环中高频打 info。
      const psEntry = progressStore.get(p.sessionId, p.agentId);
      const psKernelMetadata = progressStore.getKernelMetadata(p.sessionId, p.agentId);
      const psContextUsagePercent = psKernelMetadata?.context_usage_percent;
      const hasContextUsageMismatch = psEntry && psContextUsagePercent !== p.contextUsagePercent;
      if (p.sessionId && (!psEntry || hasContextUsageMismatch)) {
        log.debug('[ProgressMonitor] progressStore context diagnostic', {
          sessionId: p.sessionId,
          agentId: p.agentId,
          hasPsEntry: !!psEntry,
          psContextUsagePercent,
          psEstimatedTokens: psKernelMetadata?.estimated_tokens_in_context_window,
          psMaxInputTokens: psKernelMetadata?.context_window,
          pContextUsagePercent: p.contextUsagePercent,
          pEstimatedTokens: p.estimatedTokensInContextWindow,
          pMaxInputTokens: p.maxInputTokens,
        });
      }
      // Keep elapsed clock moving even when no new events are emitted.
      p.elapsedMs = Math.max(0, now - p.startTime);
      const reportKey = this.buildReportKey(p);
      const lastReportedSeq = p.lastReportedToolSeq ?? 0;
      const hasUnreportedTools = p.toolCallHistory.some((tool) => (tool.seq ?? 0) > lastReportedSeq);
      const enoughSinceLastReport = now - (p.lastReportTime ?? 0) >= this.config.intervalMs;
      const pendingTool = this.findPendingMeaningfulTool(p);
      const heartbeatIntervalMs = pendingTool
        ? this.config.intervalMs
        : this.config.intervalMs * ProgressMonitor.STALL_HEARTBEAT_FACTOR_NO_PENDING;
      const stalled = now - p.lastUpdateTime >= heartbeatIntervalMs;
      const waitLayerInfo = this.resolveWaitLayer(p, pendingTool, stalled, now);
      
      // 终态跳过：lifecycleFinalState=true 时不再报告心跳
      if (waitLayerInfo.lifecycleFinalState) {
        continue;
      }
      
      if (p.lastReportKey === reportKey) {
        // Even when summary key is stable, if tools keep flowing we still emit
        // one periodic update per interval to avoid long "silent running" windows.
        if (hasUnreportedTools && enoughSinceLastReport) {
          // continue below and send a compact batch update
        } else
        if (!stalled || !this.shouldEmitHeartbeat(p, now, heartbeatIntervalMs)) {
          continue;
        }
      }

      // 仅发送新增工具调用（避免重复）
      const newToolCalls = p.toolCallHistory.filter((tool) => (tool.seq ?? 0) > lastReportedSeq);
      const completedToolCalls = newToolCalls.filter((tool) => this.isToolRecordCompleted(tool));
      const meaningfulToolCalls = completedToolCalls.filter((tool) => !this.isLowValueToolCall(tool));
      const contextBreakdownKey = p.contextBreakdown ? JSON.stringify(p.contextBreakdown) : '';
      const contextEventChanged =
        (p.lastContextEventAt ?? undefined) !== (p.lastReportedContextEventAt ?? undefined);
      // 硬约束：没有工具调用就不推送常规进度更新。
      // 任务/reasoning/上下文变化仅用于补充已存在工具更新的摘要，不单独触发推送。
      const hasMeaningfulSignal = completedToolCalls.length > 0;

      // 没有真实信号时，仅在 stall 条件满足时发送心跳（携带内外层等待状态）。
      if (!hasMeaningfulSignal) {
        if (stalled && this.shouldEmitHeartbeat(p, now, heartbeatIntervalMs)) {
          const heartbeatSummary = this.buildHeartbeatSummary(p, now, pendingTool, {
            suspectedStall: !pendingTool,
            waitLayer: waitLayerInfo.waitLayer,
            waitKind: waitLayerInfo.waitKind,
            waitDetail: waitLayerInfo.waitDetail,
            resetHintCommand: '<##@system:progress:reset##> 或 <##@system:stopall##>',
            lifecycleStage: waitLayerInfo.lifecycleStage,
            lifecycleDetail: waitLayerInfo.lifecycleDetail,
            lifecycleAgeMs: waitLayerInfo.lifecycleAgeMs,
          });
          const roundLines = this.buildRecentRoundsSection(p);
         const report: ProgressReport = {
           type: 'progress_report',
           timestamp: new Date().toISOString(),
           sessionId: p.sessionId,
           agentId: p.agentId,
           progress: p,
           summary: [heartbeatSummary, ...roundLines].join('\n'),
           teamStatus,
         };
          const delivered = await this.deliverProgressReport(report);
          if (!delivered) continue;
          p.lastReportTime = now;
          p.lastReportedCurrentTask = p.currentTask;
          p.lastReportedReasoning = p.latestReasoning;
          p.lastReportedContextUsagePercent = p.contextUsagePercent;
          p.lastReportedEstimatedTokensInContextWindow = p.estimatedTokensInContextWindow;
          p.lastReportedMaxInputTokens = p.maxInputTokens;
          p.lastReportedContextEventAt = p.lastContextEventAt;
          p.lastReportedContextBreakdownKey = contextBreakdownKey;
        }

        // Avoid stale running records forever, but keep enough window for minute-level heartbeat updates.
        const staleIdleThresholdMs = Math.max(5 * this.config.intervalMs, 5 * 60_000);
        const inactivityMs = Math.max(0, now - p.lastUpdateTime);
        const hasRunningHints = p.hasOpenTurn === true
          || p.modelRoundsCount > 0
          || Boolean((p.currentTask ?? '').trim())
          || Boolean((p.latestReasoning ?? '').trim());
        if (
          inactivityMs >= staleIdleThresholdMs
          && p.hasOpenTurn !== true
          && !this.hasPendingToolCalls(p)
          && !pendingTool
          && !hasRunningHints
        ) {
          p.status = 'idle';
          p.lastUpdateTime = now;
        }
        continue;
      }

      const reportToolCalls = meaningfulToolCalls.length > 0 ? meaningfulToolCalls : completedToolCalls.slice(-1);
      const previewRoundDigest = meaningfulToolCalls.length > 0
        ? this.createRoundDigest(p, meaningfulToolCalls, now)
        : undefined;
      const report: ProgressReport = {
        type: 'progress_report',
        timestamp: new Date().toISOString(),
        sessionId: p.sessionId,
        agentId: p.agentId,
        progress: p,
        summary: this.buildSingleProgressSummary(
          p,
          reportToolCalls,
          contextEventChanged,
          now,
          waitLayerInfo,
          previewRoundDigest,
        ),
        teamStatus,
      };

      const delivered = await this.deliverProgressReport(report);
      if (!delivered) continue;
      // recordRoundDigest 只记录高价值工具（meaningful），不记录 cat/ls 等低价值命令
      if (previewRoundDigest) {
        this.appendRoundDigest(p, previewRoundDigest);
      }

      // Move dedup cursor only after report delivery succeeds.
      // This avoids dropping updates when callback throws.
      if (newToolCalls.length > 0) {
        this.advanceReportedToolCursor(p, newToolCalls);
      }
      p.lastReportKey = reportKey;
      p.lastReportTime = now;
      p.lastReportedCurrentTask = p.currentTask;
      p.lastReportedReasoning = p.latestReasoning;
      p.lastReportedContextUsagePercent = p.contextUsagePercent;
      p.lastReportedEstimatedTokensInContextWindow = p.estimatedTokensInContextWindow;
      p.lastReportedMaxInputTokens = p.maxInputTokens;
      p.lastReportedContextEventAt = p.lastContextEventAt;
      p.lastReportedContextBreakdownKey = contextBreakdownKey;
    }
  }

  private buildSingleProgressSummary(
    p: SessionProgress,
    newToolCalls?: ToolCallRecord[],
    includeContextEvent = false,
    now = Date.now(),
    waitInfo?: {
      waitLayer?: 'external' | 'internal';
      waitKind?: 'provider' | 'tool' | 'user' | 'unknown';
      waitDetail?: string;
      lifecycleStage?: string;
      lifecycleDetail?: string;
      lifecycleAgeMs?: number;
    },
    previewRoundDigest?: ProgressRoundDigest,
  ): string {
    const toolsToShow = (newToolCalls && newToolCalls.length > 0) ? newToolCalls : [];
    const firstReport = !p.lastReportTime;
    const currentTaskChanged = (p.currentTask ?? '') !== (p.lastReportedCurrentTask ?? '');
    const reasoningChanged = (p.latestReasoning ?? '') !== (p.lastReportedReasoning ?? '');
    const includeTaskFallback = toolsToShow.length === 0 && !reasoningChanged;
    const storedProgress = progressStore.get(p.sessionId, p.agentId);
    const storedKernelMetadata = progressStore.getKernelMetadata(p.sessionId, p.agentId);
    const data: SessionProgressData = {
      agentId: p.agentId,
      status: p.status,
      currentTask: p.currentTask,
      elapsedMs: p.elapsedMs,
      toolCallHistory: toolsToShow.map(t => ({
        toolName: t.toolName,
        params: t.params,
        result: t.result,
        error: t.error,
        success: t.success,
      })),
      latestReasoning: p.latestReasoning,
      // 从 progressStore 提取 last-known-good context snapshot（唯一真源）
      contextUsagePercent: storedKernelMetadata?.context_usage_percent ?? p.contextUsagePercent,
      estimatedTokensInContextWindow:
        storedKernelMetadata?.estimated_tokens_in_context_window ?? p.estimatedTokensInContextWindow,
      maxInputTokens: storedKernelMetadata?.context_window ?? p.maxInputTokens,
      lastContextEvent: includeContextEvent ? p.lastContextEvent : undefined,
      contextBreakdown: storedProgress?.contextBreakdown ?? p.contextBreakdown,
      contextBreakdownMode: this.config.contextBreakdownMode,
      controlTags: p.controlTags,
      controlHookNames: p.controlHookNames,
      controlBlockValid: p.controlBlockValid,
      controlIssues: p.controlIssues,
    };
    const summary = buildCompactSummary(
      data,
      (ms) => formatElapsed(ms),
      {
        includeTask: firstReport || currentTaskChanged || includeTaskFallback,
        includeReasoning: firstReport || reasoningChanged,
        headerMode: 'minimal',
        contextPendingHint:
          toolsToShow.length > 0
          && data.contextBreakdown === undefined
          && data.contextUsagePercent === undefined
          && data.estimatedTokensInContextWindow === undefined,
      },
    );
    const inferredStalled = Math.max(0, now - p.lastUpdateTime) >= this.config.intervalMs;
    const stateLines = this.buildStateLines(
      p,
      now,
      waitInfo ?? this.resolveWaitLayer(
        p,
        this.findPendingMeaningfulTool(p),
        inferredStalled,
        now,
      ),
    );
    const roundLines = this.buildRecentRoundsSection(p, previewRoundDigest);
    return [summary, ...stateLines, ...roundLines].join('\n');
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
        result: t.result,
        error: t.error,
        success: t.success,
      })),
      latestReasoning: p.latestReasoning,
      contextUsagePercent: p.contextUsagePercent,
      estimatedTokensInContextWindow: p.estimatedTokensInContextWindow,
      maxInputTokens: p.maxInputTokens,
      lastContextEvent: p.lastContextEvent,
      contextBreakdown: p.contextBreakdown,
      contextBreakdownMode: this.config.contextBreakdownMode,
      controlTags: p.controlTags,
      controlHookNames: p.controlHookNames,
      controlBlockValid: p.controlBlockValid,
      controlIssues: p.controlIssues,
    };
    return buildReportKeyUtil(data, this.latestStepSummary.get(progressKey));
  }

  private shouldEmitHeartbeat(p: SessionProgress, now: number, intervalMs = this.config.intervalMs): boolean {
    return shouldEmitHeartbeat(p, now, intervalMs);
  }

  private findPendingMeaningfulTool(p: SessionProgress): ToolCallRecord | undefined {
    return findPendingMeaningfulTool(p, ProgressMonitor.LOW_VALUE_TOOLS);
  }

  private buildHeartbeatSummary(
    p: SessionProgress,
    now: number,
    pendingTool?: ToolCallRecord,
    options?: {
      suspectedStall?: boolean;
      waitLayer?: 'external' | 'internal';
      waitKind?: 'provider' | 'tool' | 'user' | 'unknown';
      waitDetail?: string;
      resetHintCommand?: string;
      lifecycleStage?: string;
      lifecycleDetail?: string;
      lifecycleAgeMs?: number;
    },
  ): string {
    return buildHeartbeatSummary(p, now, pendingTool, options);
  }

  getProgress(sessionId: string): SessionProgress | undefined {
    const entries = this.getProgressEntriesBySession(sessionId).map(([, progress]) => progress);
    if (entries.length === 0) return undefined;

    const running = entries
      .filter((progress) => progress.status === 'running')
      .sort((a, b) => b.lastUpdateTime - a.lastUpdateTime);
    if (running.length > 0) return running[0];

    return entries.sort((a, b) => b.lastUpdateTime - a.lastUpdateTime)[0];
  }

  resetProgressState(options?: {
    sessionId?: string;
    reason?: string;
  }): {
    scope: 'all' | 'session';
    sessionId?: string;
    clearedEntries: number;
    clearedSessions: number;
  } {
    const sessionId = typeof options?.sessionId === 'string' && options.sessionId.trim().length > 0
      ? options.sessionId.trim()
      : undefined;
    const reason = typeof options?.reason === 'string' && options.reason.trim().length > 0
      ? options.reason.trim()
      : 'manual';

    if (sessionId) {
      let clearedEntries = 0;
      for (const [key, progress] of this.sessionProgress.entries()) {
        if (progress.sessionId !== sessionId) continue;
        this.sessionProgress.delete(key);
        this.latestStepSummary.delete(key);
        clearedEntries += 1;
      }
      this.sessionContextSnapshot.delete(sessionId);
      log.info('[ProgressMonitor] Progress state reset for session', {
        sessionId,
        clearedEntries,
        reason,
      });
      return {
        scope: 'session',
        sessionId,
        clearedEntries,
        clearedSessions: clearedEntries > 0 ? 1 : 0,
      };
    }

    const clearedEntries = this.sessionProgress.size;
    const clearedSessions = this.sessionContextSnapshot.size;
    this.sessionProgress.clear();
    this.latestStepSummary.clear();
    this.sessionContextSnapshot.clear();
    log.info('[ProgressMonitor] Progress state reset globally', {
      clearedEntries,
      clearedSessions,
      reason,
    });
    return {
      scope: 'all',
      clearedEntries,
      clearedSessions,
    };
  }

  cleanupCompleted(): void {
    for (const [progressKey, progress] of this.sessionProgress.entries()) {
      if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'idle') {
        // 保留最近 5 分钟的完成记录
        if (Date.now() - progress.lastUpdateTime > 5 * 60 * 1000) {
          const sameSessionRemaining = Array.from(this.sessionProgress.values())
            .some((entry) => entry !== progress && entry.sessionId === progress.sessionId);
          if (!sameSessionRemaining) {
            this.sessionContextSnapshot.delete(progress.sessionId);
          }
          this.sessionProgress.delete(progressKey);
          this.latestStepSummary.delete(progressKey);
        }
      }
    }
  }

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
