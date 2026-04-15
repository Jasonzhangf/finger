import type { SessionMessage } from '../../orchestration/session-types.js';
import type { RebuildDecision } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { estimateMessageTokens, tokenizeUserInput } from './utils.js';

export function makeRebuildDecision(
  sessionId: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number,
  budgetTokens: number = DEFAULT_CONFIG.budgetTokens,
): RebuildDecision {
  void sessionId;
  const currentTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const searchKeywords = tokenizeUserInput((currentTopic ?? '') + ' ' + userInput);

  if (currentTokens > Math.max(1, Math.floor(budgetTokens * DEFAULT_CONFIG.overflowTriggerRatio))) {
    return {
      shouldRebuild: true,
      trigger: 'overflow',
      mode: 'overflow',
      currentTokens,
      budgetTokens,
      searchKeywords,
      reason: 'context_overflow',
    };
  }

  if (
    typeof topicShiftConfidence === 'number'
    && topicShiftConfidence >= DEFAULT_CONFIG.topicShiftThreshold
    && searchKeywords.length > 0
  ) {
    return {
      shouldRebuild: true,
      trigger: 'topic_shift',
      mode: 'topic',
      currentTokens,
      budgetTokens,
      searchKeywords,
      reason: 'topic_shift_detected',
    };
  }

  return {
    shouldRebuild: false,
    trigger: null,
    mode: null,
    currentTokens,
    budgetTokens,
    searchKeywords,
    reason: 'not_needed',
  };
}

export function makeTriggerDecision(
  sessionId: string,
  prompt: string,
  messages: SessionMessage[],
  options?: { maxTokens?: number },
): {
  shouldAct: boolean;
  actionType: 'rebuild' | 'compact' | 'mixed' | null;
  reason: string;
  confidence?: number;
} {
  const decision = makeRebuildDecision(
    sessionId,
    messages,
    prompt,
    undefined,
    undefined,
    options?.maxTokens ?? DEFAULT_CONFIG.budgetTokens,
  );

  if (decision.shouldRebuild === false || decision.mode === null) {
    return { shouldAct: false, actionType: null, reason: decision.reason };
  }

  return {
    shouldAct: true,
    actionType: 'rebuild',
    reason: decision.reason,
    confidence: decision.currentTokens > 0 ? decision.currentTokens / decision.budgetTokens : undefined,
  };
}

export function clearTopicShiftState(_sessionId: string): void {
}

export function getActiveTopicShiftStates(): Map<string, { hitCount: number; lastConfidence: number; lastTopic: string }> {
  return new Map();
}
