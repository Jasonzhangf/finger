import path from 'path';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { getContextWindow, loadContextHistorySettings } from '../../core/user-settings.js';
import type { ISessionManager, SessionMessage } from '../../orchestration/session-types.js';
import type { RuntimeEvent } from '../events.js';
import { globalEventBus } from '../event-bus.js';
import { resolveLedgerPath } from '../context-ledger-memory-helpers.js';
import { forceRebuild } from './executor.js';
import type { RebuildMode, RebuildResult } from './types.js';
import { estimateMessageTokens } from './utils.js';

const log = logger.module('ContextHistoryRuntime');

type ContextHistorySessionManager = ISessionManager & {
  resolveLedgerRootForSession?: (sessionId: string) => string | null;
  updateContext?: (sessionId: string, context: Record<string, unknown>) => boolean;
};

export type ContextHistoryRebuildSource =
  | 'preflight_overflow'
  | 'retry_overflow'
  | 'manual_topic';

export interface ContextHistoryBudgetInfo {
  targetBudget: number;
  contextWindow: number;
  configuredHistoryBudget: number;
  budgetRatio: number;
}

export interface AppliedContextHistoryRebuild {
  applied: boolean;
  replaced: boolean;
  mode: RebuildMode;
  source: ContextHistoryRebuildSource;
  targetBudget: number;
  previousTokens: number;
  result: RebuildResult;
}

function inferDefaultLedgerRoot(sessionManager: ContextHistorySessionManager, sessionId: string, agentId: string): string {
  const ledgerRoot = typeof sessionManager.resolveLedgerRootForSession === 'function'
    ? sessionManager.resolveLedgerRootForSession(sessionId)
    : null;
  if (typeof ledgerRoot === 'string' && ledgerRoot.trim().length > 0) {
    return ledgerRoot;
  }
  if (agentId === 'finger-system-agent') {
    return path.join(FINGER_PATHS.home, 'system', 'sessions');
  }
  return FINGER_PATHS.sessions.dir;
}

function safeFloor(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}

export function resolveContextHistoryBudgetInfo(requestedBudget?: number): ContextHistoryBudgetInfo {
  const contextWindow = safeFloor(getContextWindow(), 20_000);
  const settings = loadContextHistorySettings();
  const configuredHistoryBudget = safeFloor(settings.historyBudgetTokens, 20_000);
  const budgetRatio = typeof settings.budgetRatio === 'number' && Number.isFinite(settings.budgetRatio)
    ? Math.min(1, Math.max(0.05, settings.budgetRatio))
    : 0.85;
  const fallbackBudget = safeFloor(Math.floor(contextWindow * budgetRatio), configuredHistoryBudget);
  const candidate = typeof requestedBudget === 'number' && Number.isFinite(requestedBudget) && requestedBudget > 0
    ? requestedBudget
    : configuredHistoryBudget > 0
      ? configuredHistoryBudget
      : fallbackBudget;
  return {
    targetBudget: Math.max(1, Math.min(contextWindow, Math.floor(candidate))),
    contextWindow,
    configuredHistoryBudget,
    budgetRatio,
  };
}

export function resolveContextHistoryBudget(requestedBudget?: number): number {
  return resolveContextHistoryBudgetInfo(requestedBudget).targetBudget;
}

function computeMessageTokens(messages: SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function toSystemNoticeSource(source: ContextHistoryRebuildSource): 'auto_context_rebuild' | 'manual_context_rebuild' {
  return source === 'manual_topic' ? 'manual_context_rebuild' : 'auto_context_rebuild';
}

async function emitRebuildEvents(params: {
  sessionId: string;
  mode: RebuildMode;
  source: ContextHistoryRebuildSource;
  targetBudget: number;
  currentMessages: SessionMessage[];
  result: RebuildResult;
}): Promise<void> {
  const budgetInfo = resolveContextHistoryBudgetInfo(params.targetBudget);
  const previousTokens = computeMessageTokens(params.currentMessages);
  const contextUsagePercent = Math.max(
    0,
    Math.min(100, Math.floor((params.result.totalTokens / Math.max(1, budgetInfo.contextWindow)) * 100)),
  );
  const systemNotice: RuntimeEvent = {
    type: 'system_notice',
    sessionId: params.sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      source: toSystemNoticeSource(params.source),
      rebuildMode: params.mode,
      trigger: params.mode === 'overflow' ? 'overflow' : 'topic_shift',
      contextUsagePercent,
      estimatedTokensInContextWindow: params.result.totalTokens,
      maxInputTokens: budgetInfo.contextWindow,
      targetBudget: params.targetBudget,
      previousTokens,
      totalTokens: params.result.totalTokens,
      digestCount: params.result.digestCount,
      rawMessageCount: params.result.rawMessageCount,
    },
  };
  const topicShiftEvent: RuntimeEvent = {
    type: 'session_topic_shift',
    sessionId: params.sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      trigger: params.mode === 'overflow' ? 'overflow' : 'topic_shift',
      confidence: 1,
      digestCount: params.result.digestCount,
      totalTokens: params.result.totalTokens,
    },
  };

  await globalEventBus.emit(systemNotice);
  await globalEventBus.emit(topicShiftEvent);

  if (params.mode === 'overflow') {
    const compressedEvent: RuntimeEvent = {
      type: 'session_compressed',
      sessionId: params.sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        originalSize: params.currentMessages.length,
        compressedSize: params.result.messages.length,
        summary: 'context_history_single_source_overflow_rebuild',
        trigger: 'auto',
        contextUsagePercent,
      },
    };
    await globalEventBus.emit(compressedEvent);
  }
}

function buildRebuildContextPatch(params: {
  source: ContextHistoryRebuildSource;
  mode: RebuildMode;
  targetBudget: number;
  result: RebuildResult;
}): Record<string, unknown> {
  return {
    contextHistorySource: 'context_history_single_source',
    contextHistoryMode: params.mode,
    contextHistoryLastRebuildSource: params.source,
    contextHistoryLastRebuildAt: new Date().toISOString(),
    contextHistoryLastBudget: params.targetBudget,
    contextHistoryDigestCount: params.result.digestCount,
    contextHistoryRawMessageCount: params.result.rawMessageCount,
    contextHistoryTotalTokens: params.result.totalTokens,
  };
}

async function finalizeAppliedRebuild(params: {
  sessionManager: ContextHistorySessionManager;
  sessionId: string;
  source: ContextHistoryRebuildSource;
  mode: RebuildMode;
  targetBudget: number;
  currentMessages: SessionMessage[];
  result: RebuildResult;
}): Promise<AppliedContextHistoryRebuild> {
  const previousTokens = computeMessageTokens(params.currentMessages);
  const replaced = params.sessionManager.replaceMessages(params.sessionId, params.result.messages);
  if (!replaced) {
    return {
      applied: false,
      replaced: false,
      mode: params.mode,
      source: params.source,
      targetBudget: params.targetBudget,
      previousTokens,
      result: params.result,
    };
  }

  if (typeof params.sessionManager.updateContext === 'function') {
    params.sessionManager.updateContext(
      params.sessionId,
      buildRebuildContextPatch({
        source: params.source,
        mode: params.mode,
        targetBudget: params.targetBudget,
        result: params.result,
      }),
    );
  }

  try {
    await emitRebuildEvents({
      sessionId: params.sessionId,
      mode: params.mode,
      source: params.source,
      targetBudget: params.targetBudget,
      currentMessages: params.currentMessages,
      result: params.result,
    });
  } catch (error) {
    log.warn('Failed to emit rebuild events', {
      sessionId: params.sessionId,
      source: params.source,
      mode: params.mode,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    applied: true,
    replaced: true,
    mode: params.mode,
    source: params.source,
    targetBudget: params.targetBudget,
    previousTokens,
    result: params.result,
  };
}

export async function executeAndApplyContextHistoryRebuild(params: {
  sessionManager: ContextHistorySessionManager;
  sessionId: string;
  agentId: string;
  mode: RebuildMode;
  source: ContextHistoryRebuildSource;
  userInput?: string;
  keywords?: string[];
  currentMessages?: SessionMessage[];
  requestedBudget?: number;
  ledgerPath?: string;
  threadMode?: string;
}): Promise<AppliedContextHistoryRebuild> {
  const currentMessages = params.currentMessages ?? params.sessionManager.getMessages(params.sessionId, 0);
  const budgetInfo = resolveContextHistoryBudgetInfo(params.requestedBudget);
  const ledgerPath = params.ledgerPath ?? resolveLedgerPath(
    inferDefaultLedgerRoot(params.sessionManager, params.sessionId, params.agentId),
    params.sessionId,
    params.agentId,
    params.threadMode ?? 'main',
  );

  const result = await forceRebuild(
    params.sessionId,
    ledgerPath,
    params.mode,
    params.userInput ?? '',
    params.keywords,
    budgetInfo.targetBudget,
    currentMessages,
  );

  if (!result.ok) {
    return {
      applied: false,
      replaced: false,
      mode: params.mode,
      source: params.source,
      targetBudget: budgetInfo.targetBudget,
      previousTokens: computeMessageTokens(currentMessages),
      result,
    };
  }

  return finalizeAppliedRebuild({
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
    source: params.source,
    mode: params.mode,
    targetBudget: budgetInfo.targetBudget,
    currentMessages,
    result,
  });
}

export async function applyPrecomputedContextHistoryRebuild(params: {
  sessionManager: ContextHistorySessionManager;
  sessionId: string;
  source: ContextHistoryRebuildSource;
  targetBudget?: number;
  currentMessages: SessionMessage[];
  result: RebuildResult;
}): Promise<AppliedContextHistoryRebuild> {
  const budgetInfo = resolveContextHistoryBudgetInfo(params.targetBudget);
  if (params.result.ok !== true) {
    return {
      applied: false,
      replaced: false,
      mode: params.result.mode,
      source: params.source,
      targetBudget: budgetInfo.targetBudget,
      previousTokens: computeMessageTokens(params.currentMessages),
      result: params.result,
    };
  }
  return finalizeAppliedRebuild({
    sessionManager: params.sessionManager,
    sessionId: params.sessionId,
    source: params.source,
    mode: params.result.mode,
    targetBudget: budgetInfo.targetBudget,
    currentMessages: params.currentMessages,
    result: params.result,
  });
}
