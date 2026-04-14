/**
 * Context History Rebuild - Session 重建
 * 
 * 两种 Rebuild 模式：
 * 1. 话题 Rebuild：搜索 digest → 相关性筛选 → 预算框选 → 时间排序
 * 2. 超限 Rebuild：直接读 ledger → 时间排序 → 预算框选
 * 
 * 核心：
 * - digest 已存在于 Ledger，不生成新 digest
 * - 只重建 Session.messages
 */

import fs from 'fs';
import path from 'path';
import type { SessionMessage } from '../../orchestration/session-types.js';
import type { TaskDigest, RebuildMode, RebuildResult, TopicSearchOptions, DEFAULT_CONFIG } from './types.js';
import {
  tokenizeUserInput,
  sortByRelevanceDescending,
  filterByRelevanceThreshold,
  takeTopPercent,
  budgetSelectByRelevance,
  budgetSelectByTime,
  sortByTimeAscending,
  digestToSessionMessage,
  validateTokenBudget,
  getRecentRounds,
  estimateDigestTokens,
} from './utils.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ContextHistoryRebuild');

/**
 * 话题 Rebuild
 * 流程：Tokenize → 搜索 → 相关性排序 → top 30% → 预算框选 → 时间排序
 */
export async function rebuildByTopic(
  sessionId: string,
  ledgerPath: string,
  userInput: string,
  options: TopicSearchOptions
): Promise<RebuildResult> {
  const { keywords, topK, relevanceThreshold, budgetTokens, timeoutMs } = options;
  
  await acquireSessionLock(sessionId, 'rebuild');
  
  try {
    log.info('Starting topic rebuild', { sessionId, keywords, budgetTokens });
    
    // 1. Tokenize 用户输入
    const searchKeywords = keywords.length > 0 ? keywords : tokenizeUserInput(userInput);
    
    if (searchKeywords.length === 0) {
      log.warn('No search keywords', { sessionId });
      return {
        ok: false,
        messages: [],
        digestCount: 0,
        totalTokens: 0,
        error: 'no_keywords',
        mode: 'topic',
      };
    }
    
    // 2. 搜索 digest
    const searchResults = await searchDigests(ledgerPath, searchKeywords, topK, timeoutMs);
    
    if (searchResults.length === 0) {
      log.warn('No search results', { sessionId, keywords: searchKeywords });
      return {
        ok: true,
        messages: [],
        digestCount: 0,
        totalTokens: 0,
        mode: 'topic',
      };
    }
    
    // 3. 按相关性排序
    const sortedByRelevance = sortByRelevanceDescending(searchResults);
    
    // 4. 取 top 30%
    const topResults = takeTopPercent(sortedByRelevance, 0.3);
    
    // 5. 预算框选
    const budgetedResults = budgetSelectByRelevance(topResults, budgetTokens);
    
    // 6. 按时间排序（从早到晚）
    const finalDigests = sortByTimeAscending(budgetedResults.map(r => r.digest));
    
    // 7. 转换为 SessionMessage
    const digestMessages = finalDigests.map(digestToSessionMessage);
    
    // 8. 添加最近 3 轮
    const allMessages = readLedgerMessages(ledgerPath);
    const recentMessages = getRecentRounds(allMessages, 3);
    
    // 9. 组建最终 messages
    const finalMessages = [...digestMessages, ...recentMessages];
    
    // 10. 二次校验
    const validation = validateTokenBudget(finalMessages, budgetTokens + 5000); // digest 20K + recent 5K
    if (!validation.ok) {
      log.warn('Token budget overflow after rebuild', {
        actualTokens: validation.actualTokens,
        overflow: validation.overflow,
      });
    }
    
    log.info('Topic rebuild completed', {
      sessionId,
      digestCount: digestMessages.length,
      recentCount: recentMessages.length,
      totalTokens: validation.actualTokens,
    });
    
    return {
      ok: true,
      messages: finalMessages,
      digestCount: digestMessages.length,
      totalTokens: validation.actualTokens,
      mode: 'topic',
    };
  } finally {
    releaseSessionLock(sessionId);
  }
}

/**
 * 超限 Rebuild
 * 流程：直接读 ledger → 时间排序 → 预算框选
 */
export async function rebuildByOverflow(
  sessionId: string,
  ledgerPath: string,
  budgetTokens: number
): Promise<RebuildResult> {
  await acquireSessionLock(sessionId, 'rebuild');
  
  try {
    log.info('Starting overflow rebuild', { sessionId, budgetTokens });
    
    // 1. 直接读 ledger digest
    const digests = readLedgerDigests(ledgerPath);
    
    if (digests.length === 0) {
      log.warn('No digests in ledger', { sessionId });
      // 没有 digest，只保留最近 3 轮
      const allMessages = readLedgerMessages(ledgerPath);
      const recentMessages = getRecentRounds(allMessages, 3);
      return {
        ok: true,
        messages: recentMessages,
        digestCount: 0,
        totalTokens: 0,
        mode: 'overflow',
      };
    }
    
    // 2. 预算框选（时间从新到旧）
    const budgetedDigests = budgetSelectByTime(digests, budgetTokens);
    
    // 3. 按时间排序（从早到晚）
    const finalDigests = sortByTimeAscending(budgetedDigests);
    
    // 4. 转换为 SessionMessage
    const digestMessages = finalDigests.map(digestToSessionMessage);
    
    // 5. 添加最近 3 轮
    const allMessages = readLedgerMessages(ledgerPath);
    const recentMessages = getRecentRounds(allMessages, 3);
    
    // 6. 组建最终 messages
    const finalMessages = [...digestMessages, ...recentMessages];
    
    // 7. 二次校验
    const validation = validateTokenBudget(finalMessages, budgetTokens + 5000);
    if (!validation.ok) {
      log.warn('Token budget overflow after overflow rebuild', {
        actualTokens: validation.actualTokens,
        overflow: validation.overflow,
      });
    }
    
    log.info('Overflow rebuild completed', {
      sessionId,
      digestCount: digestMessages.length,
      recentCount: recentMessages.length,
      totalTokens: validation.actualTokens,
    });
    
    return {
      ok: true,
      messages: finalMessages,
      digestCount: digestMessages.length,
      totalTokens: validation.actualTokens,
      mode: 'overflow',
    };
  } finally {
    releaseSessionLock(sessionId);
  }
}

/**
 * 搜索 digest（使用 mempalace 或 fts）
 */
async function searchDigests(
  ledgerPath: string,
  keywords: string[],
  topK: number,
  timeoutMs: number
): Promise<{ digest: TaskDigest; relevance: number }[]> {
  // TODO: 实现真正的搜索（mempalace/fts）
  // 当前先用简单的文本匹配作为 fallback
  try {
    const entries = readLedgerEntries(ledgerPath);
    const compactEntries = entries.filter(e => e.event_type === 'context_compact');
    
    const results: { digest: TaskDigest; relevance: number }[] = [];
    
    for (const entry of compactEntries) {
      const payload = entry.payload as { replacement_history?: TaskDigest[] };
      if (!payload.replacement_history || payload.replacement_history.length === 0) continue;
      
      for (const digest of payload.replacement_history) {
        // 简单相关性计算：关键词匹配
        const text = [digest.topic, ...digest.tags, digest.request, digest.summary].join(' ');
        const matchedKeywords = keywords.filter(k => text.toLowerCase().includes(k.toLowerCase()));
        const relevance = matchedKeywords.length / keywords.length;
        
        if (relevance > 0) {
          digest.timestamp = entry.timestamp_iso || new Date(entry.timestamp_ms).toISOString();
          digest.ledgerLine = entry.ledgerLine;
          results.push({ digest, relevance });
        }
      }
      
      if (results.length >= topK) break;
    }
    
    return results;
  } catch (error) {
    log.error('Search digests failed', error as Error, { ledgerPath, keywords });
    return [];
  }
}

/**
 * 读 ledger digest（直接读 context_compact 事件）
 */
function readLedgerDigests(ledgerPath: string): TaskDigest[] {
  if (!fs.existsSync(ledgerPath)) {
    log.warn('Ledger not found', { ledgerPath });
    return [];
  }
  
  try {
    const entries = readLedgerEntries(ledgerPath);
    const compactEntries = entries.filter(e => e.event_type === 'context_compact');
    
    const digests: TaskDigest[] = [];
    
    for (const entry of compactEntries) {
      const payload = entry.payload as { replacement_history?: TaskDigest[] };
      if (!payload.replacement_history) continue;
      
      for (const digest of payload.replacement_history) {
        digest.timestamp = entry.timestamp_iso || new Date(entry.timestamp_ms).toISOString();
        digest.ledgerLine = entry.ledgerLine;
        digest.tokenCount = estimateDigestTokens(digest);
        digests.push(digest);
      }
    }
    
    return digests;
  } catch (error) {
    log.error('Read ledger digests failed', error as Error, { ledgerPath });
    return [];
  }
}

/**
 * 读 ledger 所有消息
 */
function readLedgerMessages(ledgerPath: string): SessionMessage[] {
  if (!fs.existsSync(ledgerPath)) {
    return [];
  }
  
  try {
    const entries = readLedgerEntries(ledgerPath);
    const messageEntries = entries.filter(e => e.event_type === 'session_message');
    
    return messageEntries.map((entry, idx) => {
      const payload = entry.payload as { role: string; content: string };
      return {
        id: `msg-${entry.timestamp_ms}-${idx}`,
        role: payload.role,
        content: payload.content,
        timestamp: entry.timestamp_iso || new Date(entry.timestamp_ms).toISOString(),
        metadata: { ledgerLine: entry.ledgerLine },
      };
    });
  } catch (error) {
    log.error('Read ledger messages failed', error as Error, { ledgerPath });
    return [];
  }
}

/**
 * 读 ledger entries
 */
function readLedgerEntries(ledgerPath: string): any[] {
  const content = fs.readFileSync(ledgerPath, 'utf-8');
  const lines = content.trim().split('\n');
  
  return lines.map((line, idx) => {
    try {
      const entry = JSON.parse(line);
      entry.ledgerLine = idx;
      return entry;
    } catch {
      return null;
    }
  }).filter(e => e !== null);
}

/**
 * 统一 Rebuild 入口
 */
export async function rebuildSession(
  sessionId: string,
  ledgerPath: string,
  mode: RebuildMode,
  userInput?: string,
  keywords?: string[],
  budgetTokens: number = DEFAULT_CONFIG.budgetTokens
): Promise<RebuildResult> {
  if (mode === 'topic') {
    return rebuildByTopic(sessionId, ledgerPath, userInput || '', {
      keywords: keywords || [],
      topK: DEFAULT_CONFIG.searchTopK,
      relevanceThreshold: DEFAULT_CONFIG.relevanceThreshold,
      budgetTokens,
      timeoutMs: DEFAULT_CONFIG.searchTimeoutMs,
    });
  } else {
    return rebuildByOverflow(sessionId, ledgerPath, budgetTokens);
  }
}
