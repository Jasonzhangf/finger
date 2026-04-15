import type { SessionMessage } from '../../orchestration/session-types.js';
import type { ExecuteRebuildOptions, RebuildDecision, RebuildResult } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { estimateMessageTokens } from './utils.js';
import { makeRebuildDecision } from './decision.js';
import { rebuildSession } from './rebuild.js';

export async function executeRebuild(
  sessionId: string,
  ledgerPath: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number,
  options?: ExecuteRebuildOptions,
): Promise<{ decision: RebuildDecision; result: RebuildResult | null }> {
  const budgetTokens = options?.budgetTokens ?? DEFAULT_CONFIG.budgetTokens;
  const forcedMode = options?.forceMode ?? null;
  const decision: RebuildDecision = forcedMode
    ? {
        shouldRebuild: true,
        trigger: 'manual',
        mode: forcedMode,
        currentTokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
        budgetTokens,
        searchKeywords: options?.keywords ?? [],
        reason: 'forced',
      }
    : makeRebuildDecision(sessionId, messages, userInput, currentTopic, topicShiftConfidence, budgetTokens);

  if (decision.shouldRebuild === false || decision.mode === null) {
    return { decision, result: null };
  }

  const result = await rebuildSession({
    sessionId,
    ledgerPath,
    mode: decision.mode,
    currentMessages: messages,
    userInput,
    keywords: options?.keywords ?? decision.searchKeywords,
    budgetTokens,
  });

  return { decision, result };
}

export function checkRebuildNeeded(
  sessionId: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number,
  budgetTokens: number = DEFAULT_CONFIG.budgetTokens,
): RebuildDecision {
  return makeRebuildDecision(sessionId, messages, userInput, currentTopic, topicShiftConfidence, budgetTokens);
}

export async function forceRebuild(
  sessionId: string,
  ledgerPath: string,
  mode: 'topic' | 'overflow',
  userInput: string = '',
  keywords?: string[],
  budgetTokens: number = DEFAULT_CONFIG.budgetTokens,
  currentMessages: SessionMessage[] = [],
): Promise<RebuildResult> {
  const executed = await executeRebuild(
    sessionId,
    ledgerPath,
    currentMessages,
    userInput,
    undefined,
    undefined,
    {
      forceMode: mode,
      keywords,
      budgetTokens,
    },
  );

  return executed.result ?? {
    ok: false,
    mode,
    messages: [],
    digestCount: 0,
    rawMessageCount: 0,
    totalTokens: 0,
    error: 'forced_rebuild_failed',
    metadata: { rebuildMode: mode, targetBudget: budgetTokens },
  };
}
