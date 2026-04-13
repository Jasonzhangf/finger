/**
 * Context History Management - 类型定义
 */

/** Digest 结构 */
export interface TaskDigest {
  id: string;
  timestamp: number;
  timestampIso: string;
  summary: string;
  tags: string[];
  topic?: string;
  tokenCount: number;
  metadata: {
    compactDigest: true;
    compressedFromCurrentHistory?: boolean;
    originalMessageCount?: number;
    toolsUsed?: string[];
  };
}

/** Session Message 结构 */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  timestampIso: string;
  metadata?: Record<string, unknown>;
}

/** 一轮对话 */
export interface ConversationRound {
  userMessage: SessionMessage;
  assistantMessages: SessionMessage[];
  toolCalls: SessionMessage[];
  roundIndex: number;
}

/** 触发决策 */
export interface TriggerDecision {
  shouldAct: boolean;
  actionType: 'rebuild' | 'compact' | 'mixed' | 'none';
  reason: string;
  confidence?: number;
  details: Record<string, unknown>;
}

/** Rebuild 选项 */
export interface RebuildOptions {
  prompt: string;
  maxTokens: number;
  topK: number;
  relevanceThreshold: number;
  searchTimeoutMs: number;
  excludeSystemPrompt?: boolean;
}

/** Compact 选项 */
export interface CompactOptions {
  maxTokens: number;
  keepRecentRounds: number;
}

/** Rebuild 结果 */
export interface RebuildResult {
  ok: boolean;
  history: TaskDigest[];
  tokensUsed: number;
  latencyMs: number;
  error?: 'waiting_for_index' | 'search_no_results' | 'search_timeout' | 'search_unavailable' | 'all_filtered';
}

/** Compact 结果 */
export interface CompactResult {
  ok: boolean;
  newDigests: TaskDigest[];
  history: TaskDigest[];
  tokensUsed: number;
  error?: 'compress_failed' | 'write_failed' | 'retry_failed';
}

/** Pending Marker 结构 */
export interface PendingMarker {
  compactionId: string;
  sessionId: string;
  startedAt: number;
  startedAtIso: string;
}

/** Topic Shift 记录 */
export interface TopicShiftRecord {
  confidence: number;
  timestamp: number;
}


/** Decision 选项 */
export interface DecisionOptions {
  maxTokens?: number;
  topicShiftThreshold?: number;
  topicShiftConsecutiveHits?: number;
  overflowThresholdRatio?: number;
}
