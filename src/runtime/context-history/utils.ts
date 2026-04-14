/**
 * Context History Utils - 共享工具函数
 */

import type { SessionMessage } from '../../orchestration/session-types.js';
import type { TaskDigest } from './types.js';
import { estimateTokens } from '../../utils/token-counter.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryUtils');

/**
 * Tokenize 用户输入（直接分词，无需 LLM）
 */
export function tokenizeUserInput(input: string): string[] {
  // 简单分词：按空格、标点分割
  const tokens = input
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）【】《》\n\r\t]+/)
    .filter(t => t.length >= 2) // 过滤太短的词
    .filter(t => !isStopWord(t)); // 过滤停用词
  
  return tokens;
}

/**
 * 停用词列表
 */
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '有', '和', '与', '或', '这', '那', '我', '你', '他', '她',
  '它', '们', '什么', '怎么', '为什么', '哪里', '谁', '哪个', '多少', '几',
  '可以', '能够', '应该', '需要', '必须', '要', '想', '希望', '请', '让',
  '把', '给', '对', '向', '从', '到', '来', '去', '上', '下', '前', '后',
  '继续', '然后', '接着', '以后', '之前', '现在', '刚才', '马上', '立刻',
  '一下', '一点', '一些', '所有', '每个', '任何', '其他', '另外',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'need', 'want', 'get', 'got',
  'to', 'for', 'of', 'with', 'at', 'by', 'from', 'in', 'on', 'off',
  'up', 'down', 'out', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and',
  'but', 'if', 'or', 'because', 'as', 'until', 'while', 'of', 'at',
]);

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word);
}

/**
 * 计算 digest token 数
 */
export function estimateDigestTokens(digest: TaskDigest): number {
  const text = [
    digest.request,
    digest.summary,
    digest.topic,
    ...digest.tags,
    ...digest.key_tools,
    ...digest.key_reads,
    ...digest.key_writes,
  ].join(' ');
  return estimateTokens(text);
}

/**
 * 计算消息 token 数
 */
export function estimateMessageTokens(message: SessionMessage): number {
  const content = typeof message.content === 'string' 
    ? message.content 
    : JSON.stringify(message.content);
  return estimateTokens(content);
}

/**
 * 预算框选（按相关性从高到低累加）
 */
export function budgetSelectByRelevance(
  results: { digest: TaskDigest; relevance: number }[],
  budgetTokens: number
): { digest: TaskDigest; relevance: number }[] {
  const selected: { digest: TaskDigest; relevance: number }[] = [];
  let totalTokens = 0;
  
  // 按相关性排序（已排序）
  for (const result of results) {
    const digestTokens = estimateDigestTokens(result.digest);
    if (totalTokens + digestTokens <= budgetTokens) {
      selected.push(result);
      totalTokens += digestTokens;
    } else {
      // 超预算，停止
      break;
    }
  }
  
  log.debug('Budget select by relevance', {
    inputCount: results.length,
    outputCount: selected.length,
    totalTokens,
    budgetTokens,
  });
  
  return selected;
}

/**
 * 预算框选（按时间从新到旧累加）
 */
export function budgetSelectByTime(
  digests: TaskDigest[],
  budgetTokens: number
): TaskDigest[] {
  // 按时间排序（最新优先）
  const sorted = [...digests].sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  
  const selected: TaskDigest[] = [];
  let totalTokens = 0;
  
  for (const digest of sorted) {
    const digestTokens = estimateDigestTokens(digest);
    if (totalTokens + digestTokens <= budgetTokens) {
      selected.push(digest);
      totalTokens += digestTokens;
    } else {
      break;
    }
  }
  
  log.debug('Budget select by time', {
    inputCount: digests.length,
    outputCount: selected.length,
    totalTokens,
    budgetTokens,
  });
  
  return selected;
}

/**
 * 按时间排序（从早到晚）
 */
export function sortByTimeAscending(digests: TaskDigest[]): TaskDigest[] {
  return [...digests].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

/**
 * 按相关性排序（从高到低）
 */
export function sortByRelevanceDescending(
  results: { digest: TaskDigest; relevance: number }[]
): { digest: TaskDigest; relevance: number }[] {
  return [...results].sort((a, b) => b.relevance - a.relevance);
}

/**
 * 过滤低相关性结果
 */
export function filterByRelevanceThreshold(
  results: { digest: TaskDigest; relevance: number }[],
  threshold: number
): { digest: TaskDigest; relevance: number }[] {
  return results.filter(r => r.relevance >= threshold);
}

/**
 * 取 top N%
 */
export function takeTopPercent(
  results: { digest: TaskDigest; relevance: number }[],
  percent: number
): { digest: TaskDigest; relevance: number }[] {
  const count = Math.ceil(results.length * percent);
  return results.slice(0, count);
}

/**
 * 将 digest 转换为 SessionMessage
 */
export function digestToSessionMessage(digest: TaskDigest): SessionMessage {
  const content = [
    `[Digest] Request: ${digest.request}`,
    `Summary: ${digest.summary}`,
    `Topic: ${digest.topic}`,
    `Tags: ${digest.tags.join(', ')}`,
    `Key Tools: ${digest.key_tools.join(', ')}`,
  ].join('\n');
  
  return {
    id: `digest-${digest.timestamp}`,
    role: 'assistant',
    content,
    timestamp: digest.timestamp,
    metadata: {
      compactDigest: true,
      tokenCount: digest.tokenCount,
      tags: digest.tags,
      topic: digest.topic,
      ledgerLine: digest.ledgerLine,
    },
  };
}

/**
 * 二次校验 token 预算
 */
export function validateTokenBudget(
  messages: SessionMessage[],
  budgetTokens: number
): { ok: boolean; actualTokens: number; overflow: number } {
  const actualTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const overflow = actualTokens - budgetTokens;
  
  return {
    ok: overflow <= 0,
    actualTokens,
    overflow: Math.max(0, overflow),
  };
}

/**
 * 获取最近 N 轮消息
 */
export function getRecentRounds(
  ledgerMessages: SessionMessage[],
  rounds: number
): SessionMessage[] {
  // 识别轮次边界：user 消息作为一轮的开始
  const userMessages = ledgerMessages.filter(m => m.role === 'user');
  const recentUserCount = Math.min(rounds, userMessages.length);
  
  if (recentUserCount === 0) {
    return [];
  }
  
  // 找到倒数第 N 个 user 消息的位置
  const recentUserMessages = userMessages.slice(-recentUserCount);
  const startUserId = recentUserMessages[0].id;
  
  // 从该位置开始截取
  const startIndex = ledgerMessages.findIndex(m => m.id === startUserId);
  if (startIndex === -1) {
    return ledgerMessages.slice(-rounds * 2); // fallback
  }
  
  return ledgerMessages.slice(startIndex);
}
