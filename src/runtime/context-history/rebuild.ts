/**
 * Context History Management - 重建上下文流程
 */

import { logger } from '../../core/logger.js';
import type { TaskDigest, RebuildOptions, RebuildResult } from './types.js';
import { sortByTime, validateTokenBudget } from './utils.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import { promises as fs } from 'fs';
import * as path from 'path';

const log = logger.module('ContextHistoryRebuild');

const DEFAULT_REBUILD_OPTIONS: Partial<RebuildOptions> = {
  maxTokens: 20000,
  topK: 20,
  relevanceThreshold: 0.3,
  searchTimeoutMs: 2000,
};

interface SearchResult {
  digest: TaskDigest;
  relevance: number;
}

export async function checkIndexReady(ledgerPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(ledgerPath);
    return stat.mtimeMs < Date.now() - 3000;
  } catch {
    return false;
  }
}

export function tokenizePrompt(prompt: string): string[] {
  return prompt.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, ' ').split(' ').filter(t => t.length > 1).slice(0, 10);
}

export async function searchHistoryDigests(query: string[], memoryDir: string, topK: number, timeoutMs: number): Promise<{ ok: boolean; results: SearchResult[]; error?: 'timeout' | 'unavailable' | 'no_results' }> {
  const compactPath = path.join(memoryDir, 'compact-memory.jsonl');
  const timeoutPromise = new Promise<{ ok: false; results: never[]; error: 'timeout' }>(resolve => setTimeout(() => resolve({ ok: false, results: [], error: 'timeout' }), timeoutMs));
  
  const searchPromise = async (): Promise<{ ok: boolean; results: SearchResult[]; error?: 'unavailable' | 'no_results' }> => {
    try {
      const content = await fs.readFile(compactPath, 'utf-8');
      const lines = content.trim().split('\n');
      if (lines.length === 0) return { ok: true, results: [], error: 'no_results' };
      
      const digests: TaskDigest[] = lines.map(line => JSON.parse(line) as TaskDigest);
      const results: SearchResult[] = digests.map(digest => {
        let score = 0;
        for (const tag of digest.tags) if (query.some(q => tag.toLowerCase().includes(q))) score += 0.2;
        const summaryLower = digest.summary.toLowerCase();
        for (const q of query) if (summaryLower.includes(q)) score += 0.1;
        return { digest, relevance: Math.min(score, 1) };
      });
      
      const filtered = results.filter(r => r.relevance > 0);
      const sorted = filtered.sort((a, b) => b.relevance - a.relevance);
      return { ok: true, results: sorted.slice(0, topK) };
    } catch {
      return { ok: false, results: [], error: 'unavailable' };
    }
  };
  
  return Promise.race([timeoutPromise, searchPromise()]);
}

export function filterByRelevance(results: SearchResult[], threshold: number): SearchResult[] {
  return results.filter(r => r.relevance >= threshold).sort((a, b) => b.relevance - a.relevance);
}

export function selectByBudget(results: SearchResult[], maxTokens: number): TaskDigest[] {
  const selected: TaskDigest[] = [];
  let totalTokens = 0;
  for (const result of results) {
    if (totalTokens + result.digest.tokenCount <= maxTokens) {
      selected.push(result.digest);
      totalTokens += result.digest.tokenCount;
    } else break;
  }
  return selected;
}

export function secondaryValidation(history: TaskDigest[], maxTokens: number): TaskDigest[] {
  const validation = validateTokenBudget(history, maxTokens);
  if (validation.ok) return history;
  
  log.warn('Token budget overflow, dropping earliest digest', { overflow: validation.overflow });
  const sorted = sortByTime(history);
  const adjusted: TaskDigest[] = [];
  let totalTokens = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const digest = sorted[i];
    if (totalTokens + digest.tokenCount <= maxTokens) {
      adjusted.unshift(digest);
      totalTokens += digest.tokenCount;
    } else break;
  }
  return adjusted;
}

export async function executeRebuild(sessionId: string, memoryDir: string, options: RebuildOptions): Promise<RebuildResult> {
  const startTime = Date.now();
  const mergedOptions = { ...DEFAULT_REBUILD_OPTIONS, ...options };
  
  await acquireSessionLock(sessionId, 'rebuild');
  
  try {
    const query = tokenizePrompt(mergedOptions.prompt!);
    log.debug('Tokenize result', { query });
    
    const searchResult = await searchHistoryDigests(query, memoryDir, mergedOptions.topK!, mergedOptions.searchTimeoutMs!);
    
    if (!searchResult.ok) {
      return { ok: false, history: [], tokensUsed: 0, latencyMs: Date.now() - startTime, error: searchResult.error === 'timeout' ? 'search_timeout' : searchResult.error === 'unavailable' ? 'search_unavailable' : 'waiting_for_index' };
    }
    
    if (searchResult.results.length === 0) {
      return { ok: true, history: [], tokensUsed: 0, latencyMs: Date.now() - startTime, error: 'search_no_results' };
    }
    
    const filtered = filterByRelevance(searchResult.results, mergedOptions.relevanceThreshold!);
    if (filtered.length === 0) {
      return { ok: true, history: [], tokensUsed: 0, latencyMs: Date.now() - startTime, error: 'all_filtered' };
    }
    
    const selected = selectByBudget(filtered, mergedOptions.maxTokens!);
    const timeSorted = sortByTime(selected);
    const validated = secondaryValidation(timeSorted, mergedOptions.maxTokens!);
    
    const tokensUsed = validated.reduce((sum, d) => sum + d.tokenCount, 0);
    log.info('Rebuild completed', { sessionId, resultCount: validated.length, tokensUsed });
    
    return { ok: true, history: validated, tokensUsed, latencyMs: Date.now() - startTime };
  } finally {
    releaseSessionLock(sessionId);
  }
}
