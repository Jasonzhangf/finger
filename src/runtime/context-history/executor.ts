/**
 * Context History Executor - 执行入口
 * 
 * 整合 decision + rebuild，统一执行入口
 */

import type { SessionMessage } from '../../orchestration/session-types.js';
import type { RebuildDecision, RebuildResult } from './types.js';
import { makeRebuildDecision } from './decision.js';
import { rebuildSession } from './rebuild.js';
import { DEFAULT_CONFIG } from './types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryExecutor');

/**
 * 执行 Rebuild
 */
export async function executeRebuild(
  sessionId: string,
  ledgerPath: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number
): Promise<{ decision: RebuildDecision; result: RebuildResult | null }> {
  // 1. 判断是否需要 rebuild
  const decision = makeRebuildDecision(
    sessionId,
    messages,
    userInput,
    currentTopic,
    topicShiftConfidence
  );
  
  // 2. 如果不需要 rebuild，返回 null
  if (!decision.shouldRebuild) {
    log.debug('No rebuild needed', { sessionId, currentTokens: decision.currentTokens });
    return { decision, result: null };
  }
  
  // 3. 执行 rebuild
  log.info('Executing rebuild', {
    sessionId,
    trigger: decision.trigger,
    mode: decision.mode,
    currentTokens: decision.currentTokens,
  });
  
  const result = await rebuildSession(
    sessionId,
    ledgerPath,
    decision.mode!,
    userInput,
    decision.searchKeywords,
    decision.budgetTokens
  );
  
  // 4. 返回结果
  return { decision, result };
}

/**
 * 检查是否需要 rebuild（不执行）
 */
export function checkRebuildNeeded(
  sessionId: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number
): RebuildDecision {
  return makeRebuildDecision(
    sessionId,
    messages,
    userInput,
    currentTopic,
    topicShiftConfidence
  );
}

/**
 * 强制执行 rebuild（跳过决策）
 */
export async function forceRebuild(
  sessionId: string,
  ledgerPath: string,
  mode: 'topic' | 'overflow',
  userInput?: string,
  keywords?: string[]
): Promise<RebuildResult> {
  log.info('Force rebuild', { sessionId, mode });
  
  return rebuildSession(
    sessionId,
    ledgerPath,
    mode,
    userInput,
    keywords,
    DEFAULT_CONFIG.budgetTokens
  );
}
