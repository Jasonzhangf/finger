/**
 * Context History Types - 类型定义
 * 
 * 核心概念：
 * - Ledger 是唯一源，digest 在 Turn 结束时自动生成
 * - Rebuild 只是重建 Session.messages，不生成新 digest
 * - 两种 Rebuild：话题 Rebuild（搜索）和超限 Rebuild（直接读）
 */

import type { SessionMessage } from '../../orchestration/session-types.js';

/**
 * Digest 结构（存在于 Ledger 的 context_compact 事件中）
 */
export interface TaskDigest {
  /** 用户请求摘要 */
  request: string;
  /** 执行结果摘要 */
  summary: string;
  /** 关键工具列表 */
  key_tools: string[];
  /** 关键读取文件 */
  key_reads: string[];
  /** 关键写入文件 */
  key_writes: string[];
  /** 标签（用于搜索过滤） */
  tags: string[];
  /** 话题（用于相关性匹配） */
  topic: string;
  /** Token 数量 */
  tokenCount: number;
  /** 时间戳 */
  timestamp: string;
  /** Ledger 行号 */
  ledgerLine?: number;
}

/**
 * Rebuild 触发类型
 */
export type RebuildTrigger = 'topic_shift' | 'overflow' | 'new_session' | 'heartbeat';

/**
 * Rebuild 模式
 */
export type RebuildMode = 'topic' | 'overflow';

/**
 * Rebuild 决策
 */
export interface RebuildDecision {
  /** 是否需要 rebuild */
  shouldRebuild: boolean;
  /** 触发类型 */
  trigger: RebuildTrigger | null;
  /** Rebuild 模式 */
  mode: RebuildMode | null;
  /** 当前 token 数 */
  currentTokens: number;
  /** 预算 token 数 */
  budgetTokens: number;
  /** 搜索关键词（话题模式） */
  searchKeywords?: string[];
  /** 等待索引时间（ms） */
  indexWaitMs?: number;
}

/**
 * Rebuild 结果
 */
export interface RebuildResult {
  /** 是否成功 */
  ok: boolean;
  /** 新的 Session.messages */
  messages: SessionMessage[];
  /** digest 数量 */
  digestCount: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 错误信息 */
  error?: string;
  /** Rebuild 模式 */
  mode: RebuildMode;
}

/**
 * 搜索选项（话题模式）
 */
export interface TopicSearchOptions {
  /** 搜索关键词 */
  keywords: string[];
  /** topK */
  topK: number;
  /** 相关性阈值（低于此值丢弃） */
  relevanceThreshold: number;
  /** 预算 token 数 */
  budgetTokens: number;
  /** 搜索超时（ms） */
  timeoutMs: number;
}

/**
 * 搜索结果
 */
export interface SearchResult {
  /** digest */
  digest: TaskDigest;
  /** 相关性分数（0-1） */
  relevance: number;
}

/**
 * 预算选项
 */
export interface BudgetOptions {
  /** 预算 token 数 */
  budgetTokens: number;
  /** 最近保留轮数 */
  keepRecentRounds: number;
}

/**
 * Session 锁状态
 */
export interface SessionLock {
  /** 锁持有者 */
  holder: 'rebuild' | 'read';
  /** 获取时间 */
  acquiredAt: number;
  /** 超时时间（ms） */
  timeoutMs: number;
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG = {
  /** 预算 token 数 */
  budgetTokens: 20000,
  /** 相关性阈值 */
  relevanceThreshold: 0.3,
  /** 最近保留轮数 */
  keepRecentRounds: 3,
  /** 搜索 topK */
  searchTopK: 20,
  /** 搜索超时（ms） */
  searchTimeoutMs: 2000,
  /** 锁超时（ms） */
  lockTimeoutMs: 30000,
  /** 换话题置信度阈值 */
  topicShiftThreshold: 0.7,
  /** 换话题连续命中次数 */
  topicShiftHitCount: 2,
};
