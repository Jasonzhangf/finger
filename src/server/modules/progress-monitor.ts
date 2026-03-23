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
import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { buildCompactSummary, buildReportKey as buildReportKeyUtil, type SessionProgressData } from './progress-monitor-utils.js';

const log = logger.module('ProgressMonitor');

export interface ProgressMonitorConfig {
  intervalMs?: number; // 心跳间隔，默认 60000ms
  enabled?: boolean; // 是否启用，默认 true
  progressUpdates?: boolean; // 是否推送进度更新，默认 true
}

export interface ToolCallRecord {
  toolId?: string;
  toolName: string;
  params?: string;
  result?: string;
  error?: string;
  success?: boolean;
  timestamp: number;
}

export interface SessionProgress {
  sessionId: string;
  agentId: string;
  startTime: number;
  lastUpdateTime: number;
  toolCallsCount: number;
  modelRoundsCount: number;
  reasoningCount: number;
  status: 'running' | 'completed' | 'failed' | 'idle';
  currentTask?: string;
  elapsedMs: number;
  toolCallHistory: ToolCallRecord[];
  lastReportKey?: string;
  lastReportStatus?: string;
  lastReportTime?: number;
  lastReportedToolIndex?: number; // Track which tool calls have been reported
  latestReasoning?: string;
}

export interface ProgressReport {
  type: 'progress_report';
  timestamp: string;
  sessionId: string;
  agentId: string;
  progress: SessionProgress;
  summary: string;
}

export interface ProgressMonitorCallbacks {
  onProgressReport?: (report: ProgressReport) => Promise<void> | void;
}

const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'progress-monitor.json');
const DEFAULT_CONFIG: Required<ProgressMonitorConfig> = {
  intervalMs: 60_000,
  enabled: true,
  progressUpdates: true,
};

export async function loadProgressMonitorConfig(): Promise<Required<ProgressMonitorConfig>> {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const exists = await fs.access(CONFIG_PATH).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_CONFIG };
    }
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ProgressMonitorConfig;
    return {
      intervalMs: parsed.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
      progressUpdates: parsed.progressUpdates ?? DEFAULT_CONFIG.progressUpdates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('[ProgressMonitor] Failed to load config, using default', { message });
    return { ...DEFAULT_CONFIG };
  }
}

export class ProgressMonitor {
  private timer: NodeJS.Timeout | null = null;
  private config: Required<ProgressMonitorConfig>;
  private sessionProgress = new Map<string, SessionProgress>();
  private _stopCleanup: (() => void) | null = null;
  private _cleanupTimer: NodeJS.Timeout | null = null;
  private latestStepSummary = new Map<string, string>(); // sessionId -> latest step summary

  constructor(
    private eventBus: UnifiedEventBus,
    private deps: AgentRuntimeDeps,
    private callbacks?: ProgressMonitorCallbacks,
    config?: ProgressMonitorConfig,
  ) {
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_CONFIG.intervalMs,
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      progressUpdates: config?.progressUpdates ?? DEFAULT_CONFIG.progressUpdates,
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
        break;
      case 'tool_error':
        this.recordToolResult(progress, event.toolId, event.toolName, event.payload?.input, undefined, event.payload?.error, false);
        break;
      case 'model_round':
        progress.modelRoundsCount++;
        if (event.payload?.reasoning_count) {
          progress.reasoningCount += event.payload.reasoning_count;
        }
        if (typeof event.payload?.reasoning === 'string' && event.payload.reasoning.length > 0) {
          progress.latestReasoning = event.payload.reasoning.slice(0, 120);
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
        // Skip heartbeat/system-level dispatches (sourceAgentId contains 'system' or 'heartbeat')
        const source = event.payload?.sourceAgentId || (event as any).sourceAgentId || '';
        if (source.includes('system') || source.includes('heartbeat') || source.includes('bootstrap')) {
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
    const record: ToolCallRecord = {
      toolId,
      toolName: toolName || 'unknown',
      params: this.safeSnippet(input),
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
    const existing = toolId
      ? progress.toolCallHistory.find(t => t.toolId === toolId && !t.result && !t.error)
      : undefined;
    const record: ToolCallRecord = existing || {
      toolId,
      toolName: toolName || 'unknown',
      params: this.safeSnippet(input),
      timestamp: Date.now(),
    };
    record.result = output !== undefined ? this.safeSnippet(output) : record.result;
    record.error = error ? this.safeSnippet(error) : record.error;
    record.success = success;
    if (!existing) {
      progress.toolCallHistory.push(record);
    }
    if (progress.toolCallHistory.length > 10) {
      progress.toolCallHistory.shift();
    }
    progress.currentTask = `${record.toolName} → ${success ? '✅' : '❌'}`;
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
      const reportKey = this.buildReportKey(p);
      if (p.lastReportKey === reportKey) {
        continue;
      }
      p.lastReportKey = reportKey;
      p.lastReportTime = Date.now();

      // 仅发送新增工具调用（避免重复）
      const lastReportedIdx = p.lastReportedToolIndex ?? -1;
      const newToolCalls = p.toolCallHistory.slice(lastReportedIdx + 1);
      if (newToolCalls.length === 0) {
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

      p.lastReportedToolIndex = p.toolCallHistory.length - 1;

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
    };
    return buildCompactSummary(data, (ms) => this.formatElapsed(ms));
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
