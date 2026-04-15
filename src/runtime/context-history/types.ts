import type { SessionMessage } from '../../orchestration/session-types.js';

export type { SessionMessage } from '../../orchestration/session-types.js';

export interface TaskDigest {
  request: string;
  summary: string;
  key_tools: string[];
  key_reads: string[];
  key_writes: string[];
  tags: string[];
  topic: string;
  tokenCount: number;
  timestamp: string;
  ledgerLine?: number;
  key_entities?: string[];
  source?: 'session_snapshot' | 'ledger_context_compact' | 'turn_digest' | 'session_digest_message';
}

export type RebuildTrigger = 'overflow' | 'topic_shift' | 'manual';
export type RebuildMode = 'topic' | 'overflow';

export interface RebuildDecision {
  shouldRebuild: boolean;
  trigger: RebuildTrigger | null;
  mode: RebuildMode | null;
  currentTokens: number;
  budgetTokens: number;
  searchKeywords: string[];
  reason: string;
}

export interface RebuildResult {
  ok: boolean;
  mode: RebuildMode;
  messages: SessionMessage[];
  digestCount: number;
  rawMessageCount: number;
  totalTokens: number;
  error?: string;
  metadata: Record<string, unknown>;
}

export interface TopicSearchOptions {
  keywords: string[];
  topK: number;
  relevanceThreshold: number;
  budgetTokens: number;
  currentMessages?: SessionMessage[];
}

export interface SearchResult {
  digest: TaskDigest;
  relevance: number;
  matchedKeywords: string[];
}

export interface BudgetOptions {
  budgetTokens: number;
  keepRecentRounds: number;
}

export interface SessionLock {
  holder: 'rebuild' | 'read';
  acquiredAt: number;
  timeoutMs: number;
}

export interface ExecuteRebuildOptions {
  budgetTokens?: number;
  forceMode?: RebuildMode;
  keywords?: string[];
}

export const DEFAULT_CONFIG = {
  budgetTokens: 20_000,
  recentRawWindowTokens: 20_000,
  historicalDigestBudgetTokens: 4_000,
  relevanceThreshold: 0.15,
  keepRecentRounds: 3,
  searchTopK: 40,
  lockTimeoutMs: 30_000,
  topicShiftThreshold: 0.7,
  overflowTriggerRatio: 1,
} as const;
