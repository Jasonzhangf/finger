/**
 * Context History Management - 压缩流程
 */

import { logger } from '../../core/logger.js';
import type { TaskDigest, SessionMessage, CompactOptions, CompactResult } from './types.js';
import { sortByTime, slidingWindowBudget, mergeDigests, groupMessagesByRound, extractTagsFromMessages, estimateTokens, generateId, validateTokenBudget } from './utils.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';
import { writePendingMarker, deletePendingMarker, getCompactMemoryPath } from './recovery.js';
import { promises as fs } from 'fs';

const log = logger.module('ContextHistoryCompact');

const DEFAULT_COMPACT_OPTIONS: Partial<CompactOptions> = {
  maxTokens: 20000,
  keepRecentRounds: 6,
};

export function compressRoundToDigest(round: SessionMessage[]): TaskDigest {
  const now = Date.now();
  const userMsg = round.find(m => m.role === 'user');
  const assistantMsgs = round.filter(m => m.role === 'assistant');
  const toolCalls = round.filter(m => m.role === 'system' && m.metadata?.toolName);
  
  const userContent = userMsg?.content || '';
  const lastAssistantContent = assistantMsgs.length > 0 ? assistantMsgs[assistantMsgs.length - 1].content : '';
  const toolsUsed = toolCalls.map(t => t.metadata?.toolName as string).filter(Boolean);
  
  let summary = userContent.slice(0, 200);
  if (lastAssistantContent) summary += `\n→ ${lastAssistantContent.slice(0, 200)}`;
  if (toolsUsed.length > 0) summary += `\n[Tools: ${toolsUsed.join(', ')}]`;
  
  const tags = extractTagsFromMessages(round);
  const tokenCount = estimateTokens(summary);
  
  return {
    id: generateId(),
    timestamp: now,
    timestampIso: new Date().toISOString(),
    summary,
    tags,
    tokenCount,
    metadata: { compactDigest: true, compressedFromCurrentHistory: true, originalMessageCount: round.length, toolsUsed },
  };
}

export function compressCurrentHistory(messages: SessionMessage[]): TaskDigest[] {
  const rounds = groupMessagesByRound(messages);
  const digests: TaskDigest[] = [];
  
  for (const round of rounds) {
    const roundMessages: SessionMessage[] = [round.userMessage, ...round.assistantMessages, ...round.toolCalls].filter(Boolean);
    if (roundMessages.length > 0) {
      const digest = compressRoundToDigest(roundMessages);
      digests.push(digest);
    }
  }
  
  return sortByTime(digests);
}

export async function readExistingDigests(memoryDir: string): Promise<TaskDigest[]> {
  const compactPath = getCompactMemoryPath(memoryDir);
  try {
    const content = await fs.readFile(compactPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length === 0) return [];
    return lines.map(line => JSON.parse(line) as TaskDigest);
  } catch {
    return [];
  }
}

export async function writeDigestsToFile(memoryDir: string, digests: TaskDigest[], compactionId: string): Promise<void> {
  const compactPath = getCompactMemoryPath(memoryDir);
  const lines = digests.map(d => JSON.stringify({ ...d, compaction_id: compactionId }));
  await fs.appendFile(compactPath, lines.join('\n') + '\n', 'utf-8');
  log.info('Digests written', { count: digests.length, compactionId });
}

export async function executeCompact(sessionId: string, memoryDir: string, currentHistory: SessionMessage[], options: CompactOptions): Promise<CompactResult> {
  const mergedOptions = { ...DEFAULT_COMPACT_OPTIONS, ...options };
  
  await acquireSessionLock(sessionId, 'compact');
  
  try {
    const compactionId = await writePendingMarker(memoryDir, sessionId);
    const newDigests = compressCurrentHistory(currentHistory);
    
    if (newDigests.length === 0) {
      log.warn('No messages to compress', { sessionId });
      await deletePendingMarker(memoryDir);
      return { ok: false, newDigests: [], history: [], tokensUsed: 0, error: 'compress_failed' };
    }
    
    const existingDigests = await readExistingDigests(memoryDir);
    const allDigests = mergeDigests(existingDigests, newDigests);
    const history = slidingWindowBudget(allDigests, mergedOptions.maxTokens!);
    
    const validation = validateTokenBudget(history, mergedOptions.maxTokens!);
    if (!validation.ok) log.warn('Token budget still overflow', { overflow: validation.overflow });
    
    try {
      await writeDigestsToFile(memoryDir, newDigests, compactionId);
    } catch (writeError) {
      log.error('Failed to write digests, retrying', writeError as Error, { sessionId });
      try {
        await writeDigestsToFile(memoryDir, newDigests, compactionId);
      } catch (retryError) {
        log.error('Retry failed', retryError as Error, { sessionId });
        await deletePendingMarker(memoryDir);
        return { ok: false, newDigests: [], history: [], tokensUsed: 0, error: 'retry_failed' };
      }
    }
    
    await deletePendingMarker(memoryDir);
    
    const tokensUsed = history.reduce((sum, d) => sum + d.tokenCount, 0);
    log.info('Compact completed', { sessionId, newDigestCount: newDigests.length, historyCount: history.length, tokensUsed });
    
    return { ok: true, newDigests, history, tokensUsed };
  } finally {
    releaseSessionLock(sessionId);
  }
}
