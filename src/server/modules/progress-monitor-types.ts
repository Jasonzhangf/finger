export interface ProgressMonitorConfig {
  intervalMs?: number;
  enabled?: boolean;
  progressUpdates?: boolean;
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
  lastReportedToolIndex?: number;
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
