/**
 * Progress Monitor 类型定义
 */

export interface KernelMetadata {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  context_window: number;
  history_items_count: number;
  round: number;
  seq: number;
}

export interface ContextBreakdown {
  historyDigestTokens: number;
  currentFullTokens: number;
  systemPromptTokens: number;
  developerInstructionsTokens: number;
  totalTokens: number;
  maxInputTokens: number;
}

export interface ToolCallRecord {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  status: 'pending' | 'success' | 'error';
  timestamp: Date;
}

export interface TeamMemberStatus {
  agentId: string;
  status: 'idle' | 'waiting_model' | 'waiting_tool' | 'processing';
  currentTask?: string;
  tokenCount?: number;
}

export interface TeamStatusSnapshot {
  activeCount: number;
  members: TeamMemberStatus[];
}

export interface MailboxStatusSnapshot {
  target: string;
  unread: number;
  pending: number;
  processing: number;
}

export interface ProgressSnapshot {
  // 来自最新 kernel 响应
  latestKernelMetadata?: KernelMetadata;
  
  // 上一轮 kernel 响应（用于兜底）
  previousKernelMetadata?: KernelMetadata;
  
  // 上下文分解
  contextBreakdown?: ContextBreakdown;
  
  // 工具调用
  recentToolCalls: ToolCallRecord[];
  
  // 执行状态
  status: 'idle' | 'waiting_model' | 'waiting_tool' | 'processing';
  currentTask?: string;
  latestStepSummary?: string;
  
  // 时间戳
  lastKernelResponseAt?: Date;
  lastProgressUpdateAt?: Date;
  
  // 团队状态
  teamStatus?: TeamStatusSnapshot;
  
  // Mailbox
  mailboxStatus?: MailboxStatusSnapshot;
  
  // 元数据
  sessionId: string;
  agentId: string;
  projectPath?: string;
}

export interface ProgressUpdateEvent {
  type: 'progress_update';
  source: 'kernel_response'; // 只接受这一个来源
  sessionId: string;
  agentId: string;
  timestamp: Date;
  
  kernelMetadata?: KernelMetadata;
  contextBreakdown?: ContextBreakdown;
  toolCalls?: ToolCallRecord[];
  lastTurnSummary?: string;
  
  status?: ProgressSnapshot['status'];
  currentTask?: string;
}

export interface ProgressConfig {
  updateIntervalMinutes: number;
  display: {
    contextUsage: boolean;
    contextBreakdown: 'summary' | 'full' | 'none';
    toolCalls: 'summary' | 'full' | 'none';
    teamStatus: boolean;
    mailboxStatus: boolean;
    sessionInfo: boolean;
    reasoning: boolean;
    controlTags: boolean;
  };
  breakdownMode: 'release' | 'dev';
  truncation: {
    maxToolCallChars: number;
    maxRecentRounds: number;
    maxTeamMembers: number;
  };
}
