/**
 * Context History Management - 触发判断
 */

import { logger } from '../../core/logger.js';
import type { TriggerDecision, DecisionOptions, SessionMessage } from './types.js';
import { estimateTokens } from './utils.js';

const log = logger.module('ContextHistoryDecision');

const DEFAULT_DECISION_OPTIONS: Partial<DecisionOptions> = {
  maxTokens: 20000,
  topicShiftThreshold: 0.7,
  topicShiftConsecutiveHits: 3,
  overflowThresholdRatio: 0.9,
};

interface TopicShiftTracker {
  sessionId: string;
  consecutiveHits: number;
  lastTopicKeywords: string[];
  currentTopicKeywords: string[];
}

const topicTrackers: Map<string, TopicShiftTracker> = new Map();

export function extractTopicKeywords(prompt: string): string[] {
  return prompt.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ').split(' ').filter(w => w.length > 2).slice(0, 5);
}

export function calculateTopicSimilarity(prev: string[], curr: string[]): number {
  if (prev.length === 0 || curr.length === 0) return 0;
  const intersection = prev.filter(p => curr.some(c => c.includes(p) || p.includes(c)));
  const union = [...new Set([...prev, ...curr])];
  return intersection.length / union.length;
}

export function detectTopicShift(sessionId: string, prompt: string, options: DecisionOptions): { shifted: boolean; confidence: number; tracker: TopicShiftTracker } {
  const mergedOptions = { ...DEFAULT_DECISION_OPTIONS, ...options };
  
  let tracker = topicTrackers.get(sessionId);
  if (!tracker) {
    tracker = { sessionId, consecutiveHits: 0, lastTopicKeywords: [], currentTopicKeywords: [] };
    topicTrackers.set(sessionId, tracker);
  }
  
  const currentKeywords = extractTopicKeywords(prompt);
  const similarity = calculateTopicSimilarity(tracker.lastTopicKeywords, currentKeywords);
  const confidence = 1 - similarity;
  
  const hitThreshold = confidence >= mergedOptions.topicShiftThreshold!;
  
  if (hitThreshold) tracker.consecutiveHits++;
  else tracker.consecutiveHits = 0;
  
  tracker.currentTopicKeywords = currentKeywords;
  
  const shifted = tracker.consecutiveHits >= mergedOptions.topicShiftConsecutiveHits!;
  
  if (shifted) {
    log.info('Topic shift detected', { sessionId, consecutiveHits: tracker.consecutiveHits, confidence });
    tracker.lastTopicKeywords = currentKeywords;
    tracker.consecutiveHits = 0;
  }
  
  return { shifted, confidence, tracker };
}

export function detectEmptyContext(currentHistory: SessionMessage[]): boolean {
  return currentHistory.length === 0;
}

export function detectOverflow(currentHistory: SessionMessage[], maxTokens: number, thresholdRatio: number): { overflow: boolean; currentTokens: number; thresholdTokens: number } {
  const currentTokens = currentHistory.reduce((sum, msg) => sum + estimateTokens(msg.content || ''), 0);
  const thresholdTokens = Math.floor(maxTokens * thresholdRatio);
  const overflow = currentTokens >= thresholdTokens;
  
  if (overflow) log.warn('Context overflow detected', { currentTokens, thresholdTokens, maxTokens });
  
  return { overflow, currentTokens, thresholdTokens };
}

export function makeTriggerDecision(sessionId: string, prompt: string, currentHistory: SessionMessage[], options: DecisionOptions): TriggerDecision {
  const mergedOptions = { ...DEFAULT_DECISION_OPTIONS, ...options };
  
  const isEmpty = detectEmptyContext(currentHistory);
  const topicShift = detectTopicShift(sessionId, prompt, mergedOptions);
  const overflowCheck = detectOverflow(currentHistory, mergedOptions.maxTokens!, mergedOptions.overflowThresholdRatio!);
  
  if (topicShift.shifted && overflowCheck.overflow) {
    return {
      shouldAct: true,
      actionType: 'mixed',
      reason: 'topic_shift_with_overflow',
      details: { topicConfidence: topicShift.confidence, currentTokens: overflowCheck.currentTokens, thresholdTokens: overflowCheck.thresholdTokens },
    };
  }
  
  if (isEmpty || topicShift.shifted) {
    return {
      shouldAct: true,
      actionType: 'rebuild',
      reason: isEmpty ? 'empty_context' : 'topic_shift',
      details: { isEmpty, topicConfidence: topicShift.confidence },
    };
  }
  
  if (overflowCheck.overflow) {
    return {
      shouldAct: true,
      actionType: 'compact',
      reason: 'context_overflow',
      details: { currentTokens: overflowCheck.currentTokens, thresholdTokens: overflowCheck.thresholdTokens },
    };
  }
  
  return { shouldAct: false, actionType: 'none', reason: 'no_trigger', details: {} };
}

export function cleanupTopicTracker(sessionId: string): void {
  topicTrackers.delete(sessionId);
  log.debug('Topic tracker cleaned up', { sessionId });
}
