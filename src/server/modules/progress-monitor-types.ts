export interface ProgressMonitorConfig {
  intervalMs?: number;
  enabled?: boolean;
  progressUpdates?: boolean;
}

export interface ToolCallRecord {
  seq?: number;
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
  /**
   * Monotonic tool sequence cursor for incremental progress reports.
   * We cannot rely on array index because toolCallHistory is capped/sliding.
   */
  lastReportedToolSeq?: number;
  /**
   * Monotonic sequence generator for tool history records.
   */
  toolSeqCounter?: number;
  lastReportedCurrentTask?: string;
  lastReportedReasoning?: string;
  lastReportedContextUsagePercent?: number;
  lastReportedEstimatedTokensInContextWindow?: number;
  lastReportedMaxInputTokens?: number;
  latestReasoning?: string;
  contextUsagePercent?: number;
  estimatedTokensInContextWindow?: number;
  maxInputTokens?: number;
  contextUsageBaseTokens?: number;
  contextUsageAddedTokens?: number;
  lastContextEvent?: string;
  lastContextEventAt?: number;
  lastReportedContextEventAt?: number;
  /**
   * Allow exactly one downward context update (used after explicit rebuild/compress actions).
   * Prevents misleading "new turn low baseline" resets in normal turns.
   */
  allowContextDropOnce?: boolean;
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
