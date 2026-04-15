export interface ProgressMonitorConfig {
  intervalMs?: number;
  enabled?: boolean;
  progressUpdates?: boolean;
  contextBreakdownMode?: 'release' | 'dev';
}

export interface ContextBreakdownSnapshot {
  historyContextTokens?: number;
  historyCurrentTokens?: number;
  historyTotalTokens?: number;
  historyContextMessages?: number;
  historyCurrentMessages?: number;
  systemPromptTokens?: number;
  developerPromptTokens?: number;
  userInstructionsTokens?: number;
  environmentContextTokens?: number;
  turnContextTokens?: number;
  skillsTokens?: number;
  mailboxTokens?: number;
  projectTokens?: number;
  flowTokens?: number;
  contextSlotsTokens?: number;
  inputTextTokens?: number;
  inputMediaTokens?: number;
  inputMediaCount?: number;
  inputTotalTokens?: number;
  toolsSchemaTokens?: number;
  toolExecutionTokens?: number;
  contextLedgerConfigTokens?: number;
  responsesConfigTokens?: number;
  totalKnownTokens?: number;
  source?: string;
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

export interface ProgressRoundDigestItem {
  toolName: string;
  displayName: string;
  category: string;
  file?: string;
  success?: boolean;
}

export interface ProgressRoundDigest {
  seq: number;
  timestamp: number;
  successCount: number;
  failureCount: number;
  summary: string;
  items: ProgressRoundDigestItem[];
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
  contextBreakdown?: ContextBreakdownSnapshot;
  lastReportedContextBreakdownKey?: string;
  controlTags?: string[];
  controlHookNames?: string[];
  controlBlockValid?: boolean;
  controlIssues?: string[];
  /**
   * Allow exactly one downward context update (used after explicit rebuild/compress actions).
   * Prevents misleading "new turn low baseline" resets in normal turns.
   */
  allowContextDropOnce?: boolean;
  /**
   * Whether current turn is open (turn_start seen, turn_complete not yet seen).
   * Tool-only execution paths may not emit turn_start/turn_complete.
   */
  hasOpenTurn?: boolean;
  /**
   * Rolling digest for recent progress rounds (tool-window batches delivered to user).
   */
  recentRounds?: ProgressRoundDigest[];
  progressRoundSeq?: number;
}
 import type { TeamAgentStatus } from '../../common/team-status-state.js';

export interface ProgressReport {
  type: 'progress_report';
  timestamp: string;
  sessionId: string;
  agentId: string;
  progress: SessionProgress;
  summary: string;
  teamStatus?: TeamAgentStatus[]; // Optional: team status for observability
}

export interface ProgressMonitorCallbacks {
  onProgressReport?: (report: ProgressReport | ProgressReport[]) => Promise<void> | void;
}
