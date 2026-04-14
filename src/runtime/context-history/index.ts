/**
 * Context History Module - 导出
 * 
 * 核心概念：
 * - Ledger 是唯一源，digest 在 Turn 结束时自动生成
 * - Rebuild 只是重建 Session.messages，不生成新 digest
 * - 两种 Rebuild：话题 Rebuild（搜索）和超限 Rebuild（直接读）
 */

// Types
export type {
  TaskDigest,
  RebuildTrigger,
  RebuildMode,
  RebuildDecision,
  RebuildResult,
  TopicSearchOptions,
  SearchResult,
  BudgetOptions,
  SessionLock,
} from './types.js';

// 兼容旧命名
export type { RebuildDecision as TriggerDecision } from './types.js';

export { DEFAULT_CONFIG } from './types.js';

// Utils
export {
  tokenizeUserInput,
  estimateDigestTokens,
  estimateMessageTokens,
  budgetSelectByRelevance,
  budgetSelectByTime,
  sortByTimeAscending,
  sortByRelevanceDescending,
  filterByRelevanceThreshold,
  takeTopPercent,
  digestToSessionMessage,
  validateTokenBudget,
  getRecentRounds,
} from './utils.js';

// Decision
export {
  makeRebuildDecision,
  makeTriggerDecision,
  clearTopicShiftState,
  getActiveTopicShiftStates,
} from './decision.js';

// Rebuild
export {
  rebuildByTopic,
  rebuildByOverflow,
  rebuildSession,
} from './rebuild.js';

// Executor
export {
  executeRebuild,
  checkRebuildNeeded,
  forceRebuild,
} from './executor.js';

// 兼容旧命名
export { executeRebuild as executeContextHistoryManagement } from './executor.js';

// executeCompact 已删除（不再需要单独压缩）
// 如果有旧代码调用，返回空结果
export async function executeCompact(): Promise<{ ok: boolean; error: string }> {
  return { ok: false, error: 'executeCompact removed - use executeRebuild instead' };
}

// Lock
export {
  acquireSessionLock,
  releaseSessionLock,
  hasSessionLock,
  getSessionLock,
  clearAllLocks,
} from './lock.js';
