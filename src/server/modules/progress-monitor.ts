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

const log = logger.module('ProgressMonitor');

export interface ProgressMonitorConfig {
  intervalMs?: number; // 心跳间隔，默认 60000ms
  enabled?: boolean; // 是否启用，默认 true
  progressUpdates?: boolean; // 是否推送进度更新，默认 true
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
        break;
      case 'turn_complete':
        // 轮次完成，可能还在运行
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
        if (event.payload?.targetAgentId) {
          const status = event.payload?.status || 'queued';
          progress.currentTask = `派发 ${event.payload.targetAgentId} (${status})`;
          if (status === 'failed') progress.status = 'failed';
        }
        break;
      case 'agent_step_completed':
        progress.modelRoundsCount++;
        const payload = event.payload as { round?: number; thought?: string; action?: string; observation?: string };
        const parts: string[] = [];
        if (payload.thought) parts.push(payload.thought);
        if (payload.action) parts.push(payload.action);
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
      const report: ProgressReport = {
        type: 'progress_report',
        timestamp: new Date().toISOString(),
        sessionId: p.sessionId,
        agentId: p.agentId,
        progress: p,
        summary: this.buildSingleProgressSummary(p),
      };

      if (this.callbacks?.onProgressReport) {
        await this.callbacks.onProgressReport(report);
      }
    }
  }

  /**
   * 构建单个 session 的进度摘要
   */
  private buildSingleProgressSummary(p: SessionProgress): string {
    const elapsed = this.formatElapsed(p.elapsedMs);
    const task = p.currentTask ? ` | 当前: ${p.currentTask}` : '';
    const latestStep = this.latestStepSummary.get(p.sessionId);
    const stepInfo = latestStep ? ` | 最新步骤: ${latestStep}` : '';
    const recentTools = p.toolCallHistory.slice(-3).map((t) => {
      const status = t.success === undefined ? '' : (t.success ? '✅' : '❌');
      const params = t.params ? `(${t.params})` : '';
      const result = t.result ? ` => ${t.result}` : (t.error ? ` => ERROR: ${t.error}` : '');
      return `- ${t.toolName}${params} ${status}${result}`.trim();
    });
    const toolSummary = recentTools.length > 0 ? `\n工具调用历史:\n${recentTools.join('\n')}` : '';
    return `🔄 ${p.agentId}: ${elapsed}${task}${stepInfo}${toolSummary}`;
  }

  private buildReportKey(p: SessionProgress): string {
    const latestStep = this.latestStepSummary.get(p.sessionId) || '';
    const recentTools = p.toolCallHistory.slice(-3).map(t => `${t.toolName}:${t.params ?? ''}:${t.result ?? ''}:${t.error ?? ''}:${t.success ?? ''}`).join('|');
    return `${p.status}|${p.currentTask ?? ''}|${latestStep}|${recentTools}`;
  }

  /**
   * 构建进度摘要
   */
  private buildProgressSummary(progressList: SessionProgress[]): string {
    const lines: string[] = ['📊 执行进度报告:'];
    for (const p of progressList) {
      lines.push(this.buildSingleProgressSummary(p));
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
