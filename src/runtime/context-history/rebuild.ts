import fs from 'fs';
import type { SessionMessage } from '../../orchestration/session-types.js';
import type { RebuildMode, RebuildResult, SearchResult, TaskDigest, TopicSearchOptions } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import {
  buildDigestsFromMessages,
  dedupeDigestsBySignature,
  digestToSessionMessage,
  estimateDigestTokens,
  filterByRelevanceThreshold,
  selectNewestDigestsWithinBudget,
  selectTailMessagesWithinBudget,
  sessionDigestMessageToTaskDigest,
  sortByRelevanceDescending,
  sortByTimeAscending,
  tokenizeUserInput,
  validateTokenBudget,
} from './utils.js';
import { acquireSessionLock, releaseSessionLock } from './lock.js';

interface LedgerEntry {
  event_type?: string;
  timestamp_ms?: number;
  timestamp_iso?: string;
  payload?: Record<string, unknown>;
  ledgerLine?: number;
}

function readLedgerEntries(ledgerPath: string): LedgerEntry[] {
  if (fs.existsSync(ledgerPath) === false) return [];
  return fs.readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line, index) => {
      try {
        const parsed = JSON.parse(line) as LedgerEntry;
        return [{ ...parsed, ledgerLine: index + 1 }];
      } catch {
        return [];
      }
    });
}

function coerceDigestCandidate(
  raw: Record<string, unknown>,
  fallback: { timestamp: string; ledgerLine?: number; source: TaskDigest['source']; tags?: string[] },
): TaskDigest | null {
  const request = typeof raw.request === 'string'
    ? raw.request
    : typeof raw.content_summary === 'string'
      ? raw.content_summary
      : typeof raw.summary === 'string'
        ? raw.summary
        : '';
  const summary = typeof raw.summary === 'string'
    ? raw.summary
    : typeof raw.content_summary === 'string'
      ? raw.content_summary
      : request;
  const topic = typeof raw.topic === 'string'
    ? raw.topic
    : Array.isArray(raw.key_entities)
      ? raw.key_entities.filter((item): item is string => typeof item === 'string').slice(0, 4).join(' ')
      : '';
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((item): item is string => typeof item === 'string')
    : (fallback.tags ?? []);
  const keyTools = Array.isArray(raw.key_tools)
    ? raw.key_tools.filter((item): item is string => typeof item === 'string')
    : Array.isArray(raw.tool_calls)
      ? raw.tool_calls.filter((item): item is string => typeof item === 'string')
      : [];
  const keyEntities = Array.isArray(raw.key_entities)
    ? raw.key_entities.filter((item): item is string => typeof item === 'string')
    : [];

  const normalizedRequest = request.trim();
  const normalizedSummary = summary.trim();
  const normalizedTopic = topic.trim() || tags.slice(0, 3).join(' ')
  if (normalizedRequest == '' && normalizedSummary == '' && normalizedTopic == '') return null;

  const digest: TaskDigest = {
    request: normalizedRequest || normalizedSummary || normalizedTopic || 'historical digest',
    summary: normalizedSummary || normalizedRequest || normalizedTopic || 'historical digest',
    key_tools: keyTools,
    key_reads: Array.isArray(raw.key_reads) ? raw.key_reads.filter((item): item is string => typeof item === 'string') : [],
    key_writes: Array.isArray(raw.key_writes) ? raw.key_writes.filter((item): item is string => typeof item === 'string') : [],
    tags,
    topic: normalizedTopic || normalizedRequest || normalizedSummary,
    tokenCount: typeof raw.tokenCount === 'number'
      ? Math.max(1, Math.floor(raw.tokenCount))
      : typeof raw.token_count === 'number'
        ? Math.max(1, Math.floor(raw.token_count))
        : 0,
    timestamp: fallback.timestamp,
    ...(fallback.ledgerLine !== undefined ? { ledgerLine: fallback.ledgerLine } : {}),
    ...(keyEntities.length > 0 ? { key_entities: keyEntities } : {}),
    source: fallback.source,
  };
  digest.tokenCount = Math.max(1, digest.tokenCount || estimateDigestTokens(digest));
  return digest;
}

function readLedgerDigests(ledgerPath: string): TaskDigest[] {
  const entries = readLedgerEntries(ledgerPath);
  const digests: TaskDigest[] = [];

  for (const entry of entries) {
    const timestamp = entry.timestamp_iso || (typeof entry.timestamp_ms === 'number' ? new Date(entry.timestamp_ms).toISOString() : new Date().toISOString());
    const payload = entry.payload ?? {};
    if (entry.event_type === 'context_compact') {
      const history = Array.isArray(payload.replacement_history)
        ? payload.replacement_history.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && Array.isArray(item) === false)
        : [];
      for (const item of history) {
        const digest = coerceDigestCandidate(item, {
          timestamp,
          ledgerLine: entry.ledgerLine,
          source: 'ledger_context_compact',
        });
        if (digest) digests.push(digest);
      }
      continue;
    }

    if (entry.event_type === 'digest_block') {
      const tags = Array.isArray(payload.tags)
        ? payload.tags.filter((item): item is string => typeof item === 'string')
        : [];
      const messages = Array.isArray(payload.messages)
        ? payload.messages.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && Array.isArray(item) === false)
        : [];
      for (const message of messages) {
        const digest = coerceDigestCandidate(message, {
          timestamp,
          ledgerLine: entry.ledgerLine,
          source: 'turn_digest',
          tags,
        });
        if (digest) digests.push(digest);
      }
    }
  }

  return dedupeDigestsBySignature(digests);
}

function buildSessionDigestCandidates(currentMessages: SessionMessage[]): TaskDigest[] {
  const existingDigestMessages = currentMessages
    .map((message) => sessionDigestMessageToTaskDigest(message))
    .filter((item): item is TaskDigest => item !== null);
  const rawDigests = buildDigestsFromMessages(currentMessages.filter((message) => message.metadata?.compactDigest !== true));
  return dedupeDigestsBySignature(existingDigestMessages.concat(rawDigests));
}

function scoreDigestRelevance(digest: TaskDigest, keywords: string[]): SearchResult | null {
  const haystack = [
    digest.request,
    digest.summary,
    digest.topic,
    ...digest.tags,
    ...(digest.key_entities ?? []),
    ...digest.key_tools,
    ...digest.key_reads,
    ...digest.key_writes,
  ].join(' ').toLowerCase();
  const matchedKeywords = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
  if (matchedKeywords.length === 0) return null;
  return {
    digest,
    relevance: matchedKeywords.length / Math.max(1, keywords.length),
    matchedKeywords,
  };
}

function withContextZone(message: SessionMessage, zone: 'historical_memory' | 'working_set', rebuildMode: RebuildMode): SessionMessage {
  return {
    ...message,
    metadata: {
      ...(message.metadata ?? {}),
      contextZone: zone,
      contextHistorySource: 'context_history_single_source',
      contextHistoryMode: rebuildMode,
    },
  };
}

function matchedKeywordsForDigest(digest: TaskDigest, keywords: string[]): string[] {
  const haystack = [digest.request, digest.summary, digest.topic, ...digest.tags, ...(digest.key_entities ?? [])].join(' ').toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
}

export async function rebuildByTopic(
  sessionId: string,
  ledgerPath: string,
  userInput: string,
  options: TopicSearchOptions,
): Promise<RebuildResult> {
  await acquireSessionLock(sessionId, 'rebuild');
  try {
    const keywords = options.keywords.length > 0 ? options.keywords : tokenizeUserInput(userInput);
    if (keywords.length === 0) {
      return {
        ok: false,
        mode: 'topic',
        messages: [],
        digestCount: 0,
        rawMessageCount: 0,
        totalTokens: 0,
        error: 'no_keywords',
        metadata: { rebuildMode: 'topic', targetBudget: options.budgetTokens },
      };
    }

    const candidates = dedupeDigestsBySignature(readLedgerDigests(ledgerPath).concat(buildSessionDigestCandidates(options.currentMessages ?? [])));
    const scored = candidates
      .map((digest) => scoreDigestRelevance(digest, keywords))
      .filter((item): item is SearchResult => item !== null);
    const filtered = filterByRelevanceThreshold(scored, options.relevanceThreshold);
    const ranked = sortByRelevanceDescending(filtered.length > 0 ? filtered : scored).slice(0, options.topK);

    const selected: SearchResult[] = [];
    let usedTokens = 0;
    for (const item of ranked) {
      const tokenCount = Math.max(1, item.digest.tokenCount || estimateDigestTokens(item.digest));
      if (selected.length > 0 && usedTokens + tokenCount > options.budgetTokens) break;
      selected.push({ ...item, digest: { ...item.digest, tokenCount } });
      usedTokens += tokenCount;
    }

    const finalDigests = sortByTimeAscending(selected.map((item) => item.digest));
    const messages = finalDigests.map((digest) => withContextZone(
      digestToSessionMessage(digest, { matchedKeywords: matchedKeywordsForDigest(digest, keywords) }),
      'historical_memory',
      'topic',
    ));
    const validation = validateTokenBudget(messages, options.budgetTokens);

    return {
      ok: true,
      mode: 'topic',
      messages,
      digestCount: finalDigests.length,
      rawMessageCount: 0,
      totalTokens: validation.actualTokens,
      metadata: {
        rebuildMode: 'topic',
        targetBudget: options.budgetTokens,
        keywords,
        selectedDigestCount: finalDigests.length,
        selectedDigestIds: messages.map((message) => message.id),
      },
    };
  } finally {
    releaseSessionLock(sessionId);
  }
}

export async function rebuildByOverflow(
  sessionId: string,
  ledgerPath: string,
  currentMessages: SessionMessage[],
  budgetTokens: number,
): Promise<RebuildResult> {
  await acquireSessionLock(sessionId, 'rebuild');
  try {
    const existingDigestCandidates = currentMessages
      .map((message) => sessionDigestMessageToTaskDigest(message))
      .filter((item): item is TaskDigest => item !== null);
    const rawMessages = currentMessages.filter((message) => message.metadata?.compactDigest !== true);
    const rawWindow = selectTailMessagesWithinBudget(rawMessages, budgetTokens);
    const olderRawMessages = rawMessages.slice(0, rawWindow.startIndex);
    const historicalDigests = dedupeDigestsBySignature(
      readLedgerDigests(ledgerPath)
        .concat(existingDigestCandidates)
        .concat(buildDigestsFromMessages(olderRawMessages)),
    );
    const selectedDigests = selectNewestDigestsWithinBudget(historicalDigests, DEFAULT_CONFIG.historicalDigestBudgetTokens);

    const digestMessages = selectedDigests.map((digest) => withContextZone(
      digestToSessionMessage(digest),
      'historical_memory',
      'overflow',
    ));
    const workingSetMessages = rawWindow.messages.map((message) => withContextZone(message, 'working_set', 'overflow'));
    const messages = digestMessages.concat(workingSetMessages);
    const validation = validateTokenBudget(messages, budgetTokens + DEFAULT_CONFIG.historicalDigestBudgetTokens);

    return {
      ok: true,
      mode: 'overflow',
      messages,
      digestCount: digestMessages.length,
      rawMessageCount: workingSetMessages.length,
      totalTokens: validation.actualTokens,
      metadata: {
        rebuildMode: 'overflow',
        targetBudget: budgetTokens,
        recentRawBudget: budgetTokens,
        historicalDigestBudget: DEFAULT_CONFIG.historicalDigestBudgetTokens,
        rawWindowStartIndex: rawWindow.startIndex,
      },
    };
  } finally {
    releaseSessionLock(sessionId);
  }
}

export async function rebuildSession(params: {
  sessionId: string;
  ledgerPath: string;
  mode: RebuildMode;
  currentMessages: SessionMessage[];
  userInput?: string;
  keywords?: string[];
  budgetTokens?: number;
}): Promise<RebuildResult> {
  const budgetTokens = params.budgetTokens ?? DEFAULT_CONFIG.budgetTokens;
  if (params.mode === 'topic') {
    return rebuildByTopic(params.sessionId, params.ledgerPath, params.userInput ?? '', {
      keywords: params.keywords ?? [],
      topK: DEFAULT_CONFIG.searchTopK,
      relevanceThreshold: DEFAULT_CONFIG.relevanceThreshold,
      budgetTokens,
      currentMessages: params.currentMessages,
    });
  }
  return rebuildByOverflow(params.sessionId, params.ledgerPath, params.currentMessages, budgetTokens);
}
