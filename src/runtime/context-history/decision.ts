/**
 * Context History Management - 触发判断
 * 
 * @module decision
 * @description 判断是否需要重建或压缩，以及混合场景处理
 */

import { logger } from '../../core/logger.js';
import type { TriggerDecision, DecisionOptions, SessionMessage } from './types.js';
import { estimateTokens } from './utils.js';

const log = logger.module('ContextHistoryDecision');

/** 默认配置 */
const DEFAULT_DECISION_OPTIONS: Partial<DecisionOptions> = {
  maxTokens: 20000,
  topicShiftThreshold: 0.7, // 话题切换置信度阈值
  topicShiftConsecutiveHits: 3, // 连续命中次数
  overflowThresholdRatio: 0.9, // 超限阈值比例（90%）
};

/** 话题切换追踪 */
interface TopicShiftTracker {
  sessionId: string;
  consecutiveHits: number; // 连续命中次数
  lastTopicKeywords: string[]; // 上次话题关键词
  currentTopicKeywords: string[]; // 当前话题关键词
}

/** Session 级别的话题追踪器 */
const topicTrackers: Map<string, TopicShiftTracker> = new Map();

/**
 * 提取话题关键词
 * @param prompt - 用户输入
 * @returns 关键词列表
 */
export function extractTopicKeywords(prompt: string): string[] {
  // 简单提取：取前 5 个有意义的词
  const words = prompt
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .split(' ')
    .filter(w => w.length > 2)
    .slice(0, 5);
  
  return words;
}

/**
 * 计算话题相似度
 * @param prev - 上次关键词
 * @param curr - 当前关键词
 * @returns 相似度 0-1
 */
export function calculateTopicSimilarity(prev: string[], curr: string[]): number {
  if (prev.length === 0 || curr.length === 0) return 0;
  
  // 简单交集比例
  const intersection = prev.filter(p => curr.some(c => c.includes(p) || p.includes(c)));
  const union = [...new Set([...prev, ...curr])];
  
  return intersection.length / union.length;
}

/**
 * 检测话题切换（多轮命中）
 * @param sessionId - Session ID
 * @param prompt - 用户输入
 * @param options - 配置
 * @returns 是否切换话题
 */
export function detectTopicShift(
  sessionId: string,
  prompt: string,
  options: DecisionOptions,
): { shifted: boolean; confidence: number; tracker: TopicShiftTracker } {
  const mergedOptions = { ...DEFAULT_DECISION_OPTIONS, ...options };
  
  // 获取或创建追踪器
  let tracker = topicTrackers.get(sessionId);
  if (!tracker) {
    tracker = {
      sessionId,
      consecutiveHits: 0,
      lastTopicKeywords: [],
      currentTopicKeywords: [],
    };
    topicTrackers.set(sessionId, tracker);
  }
  
  // 提取当前关键词
  const currentKeywords = extractTopicKeywords(prompt);
  
  // 计算相似度
  const similarity = calculateTopicSimilarity(tracker.lastTopicKeywords, currentKeywords);
  const confidence = 1 - similarity; // 不相似度 = 切换置信度
  
  // 判断是否命中阈值
  const hitThreshold = confidence >= mergedOptions.topicShiftThreshold!;
  
  // 更新追踪器
  if (hitThreshold) {
    tracker.consecutiveHits++;
  } else {
    tracker.consecutiveHits = 0; // 未命中，重置计数
  }
  
  tracker.currentTopicKeywords = currentKeywords;
  
  // 判断是否切换（连续命中足够次数）
  const shifted = tracker.consecutiveHits >= mergedOptions.topicShiftConsecutiveHits!;
  
  if (shifted) {
    log.info('Topic shift detected', {
      sessionId,
      consecutiveHits: tracker.consecutiveHits,
      confidence,
    });
    
    // 切换后，更新 last 为 current，重置计数
    tracker.lastTopicKeywords = currentKeywords;
    tracker.consecutiveHits = 0;
  }
  
  return { shifted, confidence, tracker };
}

/**
 * 检测空上下文
 * @param currentHistory - 当前上下文
 * @returns 是否为空
 */
export function detectEmptyContext(currentHistory: SessionMessage[]): boolean {
  return currentHistory.length === 0;
}

/**
 * 检测上下文超限
 * @param currentHistory - 当前上下文
 * @param maxTokens - 最大 token
 * @param thresholdRatio - 阈值比例
 * @returns 是否超限
 */
export function detectOverflow(
  currentHistory: SessionMessage[],
  maxTokens: number,
  thresholdRatio: number,
): { overflow: boolean; currentTokens: number; thresholdTokens: number } {
  // 计算当前上下文 token
  const currentTokens = currentHistory.reduce((sum, msg) => {
    const content = msg.content || '';
    return sum + estimateTokens(content);
  }, 0);
  
  const thresholdTokens = Math.floor(maxTokens * thresholdRatio);
  const overflow = currentTokens >= thresholdTokens;
  
  if (overflow) {
    log.warn('Context overflow detected', {
      currentTokens,
      thresholdTokens,
      maxTokens,
    });
  }
  
  return { overflow, currentTokens, thresholdTokens };
}

/**
 * 综合判断触发决策
 * @param sessionId - Session ID
 * @param prompt - 用户输入
 * @param currentHistory - 当前上下文
 * @param options - 配置
 * @returns 触发决策
 */
export function makeTriggerDecision(
  sessionId: string,
  prompt: string,
  currentHistory: SessionMessage[],
  options: DecisionOptions,
): TriggerDecision {
  const mergedOptions = { ...DEFAULT_DECISION_OPTIONS, ...options };
  
  // 1. 检测空上下文
  const isEmpty = detectEmptyContext(currentHistory);
  
  // 2. 检测话题切换
  const topicShift = detectTopicShift(sessionId, prompt, mergedOptions);
  
  // 3. 检测超限
  const overflowCheck = detectOverflow(
    currentHistory,
    mergedOptions.maxTokens!,
    mergedOptions.overflowThresholdRatio!,
  );
  
  // 4. 综合判断
  let decision: TriggerDecision;
  
  // 混合场景：换话题 + 超限
  if (topicShift.shifted && overflowCheck.overflow) {
    decision = {
      shouldAct: true,
      actionType: 'mixed',
      reason: 'topic_shift_with_overflow',
      details: {
        topicConfidence: topicShift.confidence,
        currentTokens: overflowCheck.currentTokens,
        thresholdTokens: overflowCheck.thresholdTokens,
      },
    };
    log.info('Mixed scenario: topic shift + overflow', { sessionId, decision });
  }
  // 单独场景：换话题或空上下文 → 重建
  else if (isEmpty || topicShift.shifted) {
    decision = {
      shouldAct: true,
      actionType: 'rebuild',
      reason: isEmpty ? 'empty_context' : 'topic_shift',
      details: {
        isEmpty,
        topicConfidence: topicShift.confidence,
      },
    };
    log.info('Rebuild scenario', { sessionId, decision });
  }
  // 单独场景：超限 → 压缩
  else if (overflowCheck.overflow) {
    decision = {
      shouldAct: true,
      actionType: 'compact',
      reason: 'context_overflow',
      details: {
        currentTokens: overflowCheck.currentTokens,
        thresholdTokens: overflowCheck.thresholdTokens,
      },
    };
    log.info('Compact scenario', { sessionId, decision });
  }
  // 无需操作
  else {
    decision = {
      shouldAct: false,
      actionType: 'none',
      reason: 'no_trigger',
      details: {},
    };
  }
  
  return decision;
}

/**
 * 清理 Session 的话题追踪器
 * @param sessionId - Session ID
 */
export function cleanupTopicTracker(sessionId: string): void {
  topicTrackers.delete(sessionId);
  log.debug('Topic tracker cleaned up', { sessionId });
}
