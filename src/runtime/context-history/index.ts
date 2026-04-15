export type {
  SessionMessage,
  TaskDigest,
  RebuildTrigger,
  RebuildMode,
  RebuildDecision,
  RebuildResult,
  TopicSearchOptions,
  SearchResult,
  BudgetOptions,
  SessionLock,
  ExecuteRebuildOptions,
} from './types.js';

export type { RebuildDecision as TriggerDecision } from './types.js';

export { DEFAULT_CONFIG } from './types.js';

export {
  tokenizeUserInput,
  estimateDigestTokens,
  estimateMessageTokens,
  sortByTimeAscending,
  sortByRelevanceDescending,
  filterByRelevanceThreshold,
  takeTopPercent,
  digestToSessionMessage,
  validateTokenBudget,
  getRecentRounds,
  buildDigestsFromMessages,
  sessionDigestMessageToTaskDigest,
} from './utils.js';

export {
  makeRebuildDecision,
  makeTriggerDecision,
  clearTopicShiftState,
  getActiveTopicShiftStates,
} from './decision.js';

export {
  rebuildByTopic,
  rebuildByOverflow,
  rebuildSession,
} from './rebuild.js';

export {
  resolveContextHistoryBudget,
  resolveContextHistoryBudgetInfo,
  executeAndApplyContextHistoryRebuild,
  applyPrecomputedContextHistoryRebuild,
} from './runtime-integration.js';

export {
  executeRebuild,
  checkRebuildNeeded,
  forceRebuild,
} from './executor.js';

export { executeRebuild as executeContextHistoryManagement } from './executor.js';

export {
  acquireSessionLock,
  releaseSessionLock,
  hasSessionLock,
  getSessionLock,
  clearAllLocks,
} from './lock.js';
