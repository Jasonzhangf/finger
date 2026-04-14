/**
 * Context History Management - 执行入口
 */

import { logger } from '../../core/logger.js';
import type { SessionMessage, TriggerDecision, CompactOptions, RebuildOptions } from './types.js';
import { makeTriggerDecision } from './decision.js';
import { executeRebuild } from './rebuild.js';
import { executeCompact } from './compact.js';
import { checkCrashRecovery } from './recovery.js';

const log = logger.module('ContextHistoryExecutor');

const DEFAULT_COMPACT_OPTIONS: CompactOptions = {
  maxTokens: 20000,
  keepRecentRounds: 6,
};

const DEFAULT_REBUILD_OPTIONS: RebuildOptions = {
  prompt: '',
  maxTokens: 20000,
  topK: 20,
  relevanceThreshold: 0.3,
  searchTimeoutMs: 2000,
};

/**
 * 执行上下文历史管理
 */
export async function executeContextHistoryManagement(
  sessionId: string,
  prompt: string,
  memoryDir: string,
  currentHistory: SessionMessage[],
): Promise<{
  ok: boolean;
  historyDigests: SessionMessage[];
  decision: TriggerDecision;
  error?: string;
}> {
  const startTime = Date.now();
  log.info('Context history management started', { sessionId, promptLength: prompt.length, currentHistoryCount: currentHistory.length });

  // 1. 崩溃恢复检查
  const crashCheck = await checkCrashRecovery(memoryDir);
  if (crashCheck.needsRecovery && crashCheck.pendingMarker) {
    log.warn('Found pending marker, will recover on next compact', { sessionId, compactionId: crashCheck.pendingMarker.compactionId });
  // 崩溃恢复需要重新执行压缩，但我们没有 currentHistory，所以只能标记为需要恢复
    // 实际恢复逻辑会在下次压缩时执行
  }

  // 2. 触发决策
  const decision = makeTriggerDecision(sessionId, prompt, currentHistory, { maxTokens: 20000 });
  log.info('Trigger decision made', { sessionId, decision });

  // 3. 根据决策执行
  if (!decision.shouldAct) {
    log.info('No action needed', { sessionId, reason: decision.reason });
    return { ok: true, historyDigests: [], decision };
  }

  const compactOpts: CompactOptions = DEFAULT_COMPACT_OPTIONS;
  const rebuildOpts: RebuildOptions = { ...DEFAULT_REBUILD_OPTIONS, prompt };

  // 混合场景：先压缩，再重建
  if (decision.actionType === 'mixed') {
    log.info('Mixed scenario: compact then rebuild', { sessionId });

    const compactResult = await executeCompact(sessionId, memoryDir, currentHistory, compactOpts);
    if (!compactResult.ok) {
      log.error('Compact failed in mixed scenario', new Error(compactResult.error || 'unknown'), { sessionId });
      return { ok: false, historyDigests: [], decision, error: compactResult.error };
    }

    const rebuildResult = await executeRebuild(sessionId, memoryDir, rebuildOpts);
    if (!rebuildResult.ok) {
      log.error('Rebuild failed in mixed scenario', new Error(rebuildResult.error || 'unknown'), { sessionId });
      return { ok: false, historyDigests: [], decision, error: rebuildResult.error };
    }

    const historyDigests: SessionMessage[] = rebuildResult.history.map(d => ({
      id: d.id,
      role: 'system' as const,
      content: `[Digest @ ${d.timestampIso}] ${d.summary}`,
      timestamp: d.timestamp,
      timestampIso: d.timestampIso,
      metadata: { digestId: d.id, compactDigest: true },
    }));

    log.info('Mixed scenario completed', { sessionId, digestCount: historyDigests.length, latencyMs: Date.now() - startTime });
    return { ok: true, historyDigests, decision };
  }

  // 重建场景
  if (decision.actionType === 'rebuild') {
    log.info('Rebuild scenario', { sessionId, reason: decision.reason });

    const rebuildResult = await executeRebuild(sessionId, memoryDir, rebuildOpts);
    if (!rebuildResult.ok) {
      log.error('Rebuild failed', new Error(rebuildResult.error || 'unknown'), { sessionId });
      return { ok: false, historyDigests: [], decision, error: rebuildResult.error };
    }

    const historyDigests: SessionMessage[] = rebuildResult.history.map(d => ({
      id: d.id,
      role: 'system' as const,
      content: `[Digest @ ${d.timestampIso}] ${d.summary}`,
      timestamp: d.timestamp,
      timestampIso: d.timestampIso,
      metadata: { digestId: d.id, compactDigest: true },
    }));

    log.info('Rebuild completed', { sessionId, digestCount: historyDigests.length, latencyMs: Date.now() - startTime });
    return { ok: true, historyDigests, decision };
  }

  // 压缩场景
  if (decision.actionType === 'compact') {
    log.info('Compact scenario', { sessionId, reason: decision.reason });

    const compactResult = await executeCompact(sessionId, memoryDir, currentHistory, compactOpts);
    if (!compactResult.ok) {
      log.error('Compact failed', new Error(compactResult.error || 'unknown'), { sessionId });
      return { ok: false, historyDigests: [], decision, error: compactResult.error };
    }

    const historyDigests: SessionMessage[] = compactResult.history.map(d => ({
      id: d.id,
      role: 'system' as const,
      content: `[Digest @ ${d.timestampIso}] ${d.summary}`,
      timestamp: d.timestamp,
      timestampIso: d.timestampIso,
      metadata: { digestId: d.id, compactDigest: true },
    }));

    log.info('Compact completed', { sessionId, digestCount: historyDigests.length, tokensUsed: compactResult.tokensUsed, latencyMs: Date.now() - startTime });
    return { ok: true, historyDigests, decision };
  }

  log.error('Unknown action type', new Error('unknown_action'), { sessionId, actionType: decision.actionType });
  return { ok: false, historyDigests: [], decision, error: 'unknown_action' };
}
