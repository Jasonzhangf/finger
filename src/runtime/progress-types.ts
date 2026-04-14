/**
 * Progress Monitor 类型定义
 * 用于全局唯一的进度数据存储和消费
 */

/** Kernel 响应元数据（来自 model_round） */
export interface KernelMetadata {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_window: number;
  history_items_count: number;
  tool_count: number;
  reasoning_count: number;
  finish_reason: string;
  response_status: string;
}

/** 上下文分解（Token 预算分配） */
export interface ContextBreakdown {
  historyDigestTokens: number;
  currentFullTokens: number;
  systemPromptTokens: number;
  developerInstructionsTokens: number;
  otherOptionsTokens: number;
}

/** 工具调用摘要 */
export interface ToolCallSummary {
  name: string;
  summary: string;
  timestamp: number;
  status: 'success' | 'error' | 'pending';
}

/** 进度快照（全局唯一数据结构） */
export interface ProgressSnapshot {
  sessionId: string;
  agentId: string;
  timestamp: number;
  timestamp_iso: string;
  kernelMetadata: KernelMetadata | null;
  contextBreakdown: ContextBreakdown | null;
  toolCalls: ToolCallSummary[];
  pendingTool: ToolCallSummary | null;
  lastTurnSummary: string;
  recentRounds: string[];
  internalState: string;
  internalStateDuration: number;
  externalState: string;
  externalStateDuration: number;
  mailboxStatus: { unread: number; pending: number; processing: number };
  teamStatus: { agents: Array<{ agentId: string; status: string; task: string }> };
  contextUsagePercent: number;
}

/** 进度更新事件（唯一数据来源） */
export interface ProgressUpdateEvent {
  type: 'progress_update';
  source: 'kernel_response';
  sessionId: string;
  agentId: string;
  timestamp: number;
  kernelMetadata?: KernelMetadata;
  contextBreakdown?: ContextBreakdown;
  toolCalls?: ToolCallSummary[];
  lastTurnSummary?: string;
  internalState?: string;
  externalState?: string;
}

/** 进度显示配置 */
export interface ProgressDisplayConfig {
  contextUsage: boolean;
  toolCalls: boolean;
  teamStatus: boolean;
  mailboxStatus: boolean;
  recentRounds: boolean;
  internalState: boolean;
  externalState: boolean;
  stuckWarning: boolean;
}

/** 进度配置 */
export interface ProgressConfig {
  updateIntervalMinutes: number;
  display: ProgressDisplayConfig;
  truncation: {
    maxToolCallChars: number;
    maxRecentRounds: number;
    maxTurnSummaryChars: number;
  };
  stuckThresholdMinutes: number;
}
