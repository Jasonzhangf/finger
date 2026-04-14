/**
 * Context History Decision - 触发判断
 * 
 * 判断是否需要 Rebuild Session.messages
 * 
 * 触发场景：
 * - topic_shift: 换话题（多轮命中）
 * - overflow: 上下文超限
 * - new_session: 新 session
 * - heartbeat: 心跳任务
 */

import type { SessionMessage } from '../../orchestration/session-types.js';
import type { RebuildDecision, RebuildTrigger, RebuildMode } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { estimateMessageTokens } from './utils.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryDecision');

/**
 * Session 的换话题状态追踪
 */
const topicShiftState = new Map<string, {
  hitCount: number;
  lastConfidence: number;
  lastTopic: string;
}>();

/**
 * 判断是否需要 Rebuild（新接口）
 */
export function makeRebuildDecision(
  sessionId: string,
  messages: SessionMessage[],
  userInput: string,
  currentTopic?: string,
  topicShiftConfidence?: number
): RebuildDecision {
  const budgetTokens = DEFAULT_CONFIG.budgetTokens;
  const currentTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  
  // 1. 检查是否新 session
  if (messages.length === 0) {
    log.info('New session detected', { sessionId });
    return {
      shouldRebuild: true,
      trigger: 'new_session',
      mode: 'topic',
      currentTokens: 0,
      budgetTokens,
    };
  }
  
  // 2. 检查是否心跳任务
  if (sessionId.startsWith('hb-session-')) {
    log.info('Heartbeat session detected', { sessionId });
    return {
      shouldRebuild: true,
      trigger: 'heartbeat',
      mode: 'topic',
      currentTokens,
      budgetTokens,
    };
  }
  
  // 3. 检查是否上下文超限
  if (currentTokens > budgetTokens * 2) { // 超过 40K 才触发
    log.info('Overflow detected', { sessionId, currentTokens, budgetTokens });
    return {
      shouldRebuild: true,
      trigger: 'overflow',
      mode: 'overflow',
      currentTokens,
      budgetTokens,
    };
  }
  
  // 4. 检查是否换话题（多轮命中）
  if (topicShiftConfidence !== undefined && topicShiftConfidence > DEFAULT_CONFIG.topicShiftThreshold) {
    const state = topicShiftState.get(sessionId) || {
      hitCount: 0,
      lastConfidence: 0,
      lastTopic: '',
    };
    
    // 如果话题真的变了（不是连续同一话题的高置信度）
    if (currentTopic && currentTopic !== state.lastTopic) {
      state.hitCount++;
      state.lastConfidence = topicShiftConfidence;
      state.lastTopic = currentTopic;
      topicShiftState.set(sessionId, state);
      
      log.debug('Topic shift hit', {
        sessionId,
        hitCount: state.hitCount,
        confidence: topicShiftConfidence,
        topic: currentTopic,
      });
      
      // 连续 N 次命中才触发
      if (state.hitCount >= DEFAULT_CONFIG.topicShiftHitCount) {
        log.info('Topic shift confirmed', {
          sessionId,
          hitCount: state.hitCount,
          confidence: topicShiftConfidence,
          topic: currentTopic,
        });
        
        // 清除状态
        topicShiftState.delete(sessionId);
        
        return {
          shouldRebuild: true,
          trigger: 'topic_shift',
          mode: 'topic',
          currentTokens,
          budgetTokens,
          searchKeywords: extractKeywords(currentTopic, userInput),
        };
      }
    } else {
      // 同一话题，不累加
      state.lastConfidence = topicShiftConfidence;
      topicShiftState.set(sessionId, state);
    }
  } else {
    // 低置信度，清除状态
    if (topicShiftState.has(sessionId)) {
      const state = topicShiftState.get(sessionId)!;
      if (topicShiftConfidence === undefined || topicShiftConfidence < DEFAULT_CONFIG.topicShiftThreshold * 0.5) {
        // 大幅降低才清除
        topicShiftState.delete(sessionId);
        log.debug('Topic shift state cleared', { sessionId });
      }
    }
  }
  
  // 5. 不需要 rebuild
  return {
    shouldRebuild: false,
    trigger: null,
    mode: null,
    currentTokens,
    budgetTokens,
  };
}

/**
 * 兼容旧接口 makeTriggerDecision
 * 
 * 旧接口参数：sessionId, prompt, messages, { maxTokens }
 * 新接口参数：sessionId, messages, userInput, currentTopic?, topicShiftConfidence?
 */
export function makeTriggerDecision(
  sessionId: string,
  prompt: string,
  messages: SessionMessage[],
  options?: { maxTokens?: number }
): { 
  shouldAct: boolean; 
  actionType: 'rebuild' | 'compact' | 'mixed' | null;
  reason: string;
  confidence?: number;
} {
  const budgetTokens = options?.maxTokens || DEFAULT_CONFIG.budgetTokens;
  const currentTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  
  // 1. 检查是否新 session
  if (messages.length === 0) {
    return {
      shouldAct: true,
      actionType: 'rebuild',
      reason: 'new_session',
    };
  }
  
  // 2. 检查是否心跳任务
  if (sessionId.startsWith('hb-session-')) {
    return {
      shouldAct: true,
      actionType: 'rebuild',
      reason: 'heartbeat',
    };
  }
  
  // 3. 检查是否上下文超限
  if (currentTokens > budgetTokens * 2) {
    return {
      shouldAct: true,
      actionType: 'compact',
      reason: 'overflow',
      confidence: currentTokens / budgetTokens,
    };
  }
  
  // 4. 不需要 action
  return {
    shouldAct: false,
    actionType: null,
    reason: 'normal',
  };
}

/**
 * 从话题和用户输入提取关键词
 */
function extractKeywords(topic: string | undefined, userInput: string): string[] {
  const keywords: string[] = [];
  
  if (topic) {
    // 话题分割成关键词
    keywords.push(...topic.split(/[\s,，、]+/).filter(k => k.length >= 2));
  }
  
  // 用户输入的关键词
  const inputKeywords = userInput
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）【】《》\n\r\t]+/)
    .filter(k => k.length >= 3);
  
  keywords.push(...inputKeywords);
  
  // 去重
  return [...new Set(keywords)];
}

/**
 * 清除 session 的换话题状态
 */
export function clearTopicShiftState(sessionId: string): void {
  topicShiftState.delete(sessionId);
}

/**
 * 获取所有活跃的换话题状态
 */
export function getActiveTopicShiftStates(): Map<string, { hitCount: number; lastConfidence: number; lastTopic: string }> {
  return new Map(topicShiftState);
}
