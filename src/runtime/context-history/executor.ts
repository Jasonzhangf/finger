/**
 * Context History Management - 执行入口
 */

import { logger } from '../../core/logger.js';
import type { SessionMessage, ExecutorResult } from './types.js';
import { makeTriggerDecision } from './decision.js';
import { executeRebuild, checkIndexReady } from './rebuild.js';
import { executeCompact } from './compact.js';
import { getRecentRounds, sortByTime } from './utils.js';

const log = logger.module('ContextHistoryExecutor');

const DEFAULT_EXECUTOR_OPTIONS = {
  maxTokens: 20000,
  keepRecentRounds: 6,
};

export function getRecentHistory(messages: SessionMessage[], keepRounds: number): SessionMessage[] {
  const rounds = getRecentRounds(messages, keepRounds);
  const recent: SessionMessage[] = [];
  
  for (const round of rounds) {
    if (round.userMessage) recent.push(round.userMessage);
    recent.push(...round.assistantMessages);
    recent.push(...round.toolCalls);
  }
  
  return sortByTime(recent);
}

export async function executeContextHistoryManagement(
  sessionId: string,
  memoryDir: string,
  prompt: string,
  currentHistory: SessionMessage[],
  ledgerPath: string,
): Promise<ExecutorResult> {
  const startTime = Date.now();
  
  log.info('Context history management triggered', { sessionId, promptLength: prompt.length });
  
  const indexReady = await checkIndexReady(ledgerPath);
  if (!indexReady) log.warn('Index not ready', { sessionId, ledgerPath });
  
  const decision = makeTriggerDecision(sessionId, prompt, currentHistory, { maxTokens: DEFAULT_EXECUTOR_OPTIONS.maxTokens });
  log.info('Trigger decision', { sessionId, decision });
  
  if (!decision.shouldAct) {
    return {
      ok: true,
      action: 'none',
      contextHistory: [],
      currentHistory: getRecentHistory(currentHistory, DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds),
      tokensUsed: 0,
      latencyMs: Date.now() - startTime,
    };
  }
  
  if (decision.actionType === 'mixed') {
    log.info('Mixed scenario', { sessionId });
    
    const compactResult = await executeCompact(sessionId, memoryDir, currentHistory, { maxTokens: DEFAULT_EXECUTOR_OPTIONS.maxTokens, keepRecentRounds: DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds });
    if (!compactResult.ok) {
      return { ok: false, action: 'mixed', contextHistory: [], currentHistory, tokensUsed: 0, latencyMs: Date.now() - startTime, error: compactResult.error };
    }
    
    const recentCurrent = getRecentHistory(currentHistory, DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds);
    
    if (indexReady) {
      const rebuildResult = await executeRebuild(sessionId, memoryDir, { prompt, maxTokens: DEFAULT_EXECUTOR_OPTIONS.maxTokens, topK: 20, relevanceThreshold: 0.3, searchTimeoutMs: 2000 });
      return { ok: rebuildResult.ok, action: 'mixed', contextHistory: rebuildResult.history, currentHistory: recentCurrent, tokensUsed: rebuildResult.tokensUsed + compactResult.tokensUsed, latencyMs: Date.now() - startTime, error: rebuildResult.error };
    }
    
    return { ok: true, action: 'compact_only', contextHistory: compactResult.history, currentHistory: recentCurrent, tokensUsed: compactResult.tokensUsed, latencyMs: Date.now() - startTime, error: 'waiting_for_index' };
  }
  
  if (decision.actionType === 'rebuild') {
    if (!indexReady) return { ok: false, action: 'rebuild', contextHistory: [], currentHistory: getRecentHistory(currentHistory, DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds), tokensUsed: 0, latencyMs: Date.now() - startTime, error: 'waiting_for_index' };
    
    const rebuildResult = await executeRebuild(sessionId, memoryDir, { prompt, maxTokens: DEFAULT_EXECUTOR_OPTIONS.maxTokens, topK: 20, relevanceThreshold: 0.3, searchTimeoutMs: 2000 });
    return { ok: rebuildResult.ok, action: 'rebuild', contextHistory: rebuildResult.history, currentHistory: getRecentHistory(currentHistory, DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds), tokensUsed: rebuildResult.tokensUsed, latencyMs: Date.now() - startTime, error: rebuildResult.error };
  }
  
  if (decision.actionType === 'compact') {
    const compactResult = await executeCompact(sessionId, memoryDir, currentHistory, { maxTokens: DEFAULT_EXECUTOR_OPTIONS.maxTokens, keepRecentRounds: DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds });
    return { ok: compactResult.ok, action: 'compact', contextHistory: compactResult.history, currentHistory: getRecentHistory(currentHistory, DEFAULT_EXECUTOR_OPTIONS.keepRecentRounds), tokensUsed: compactResult.tokensUsed, latencyMs: Date.now() - startTime, error: compactResult.error };
  }
  
  return { ok: false, action: 'none', contextHistory: [], currentHistory, tokensUsed: 0, latencyMs: Date.now() - startTime, error: 'unknown_action' };
}
