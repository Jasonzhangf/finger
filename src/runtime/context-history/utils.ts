import type { SessionMessage } from '../../orchestration/session-types.js';
import type { SearchResult, TaskDigest } from './types.js';
import { estimateTokens } from '../../utils/token-counter.js';

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
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while',
]);

export function tokenizeUserInput(input: string): string[] {
  return Array.from(new Set(
    input
      .toLowerCase()
      .split(/[\s,，。！？、；："''（）【】《》\n\r\t/\\]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .filter((item) => !STOP_WORDS.has(item)),
  ));
}

export function estimateDigestTokens(digest: TaskDigest): number {
  const text = [
    digest.request,
    digest.summary,
    digest.topic,
    ...digest.tags,
    ...(digest.key_entities ?? []),
    ...digest.key_tools,
    ...digest.key_reads,
    ...digest.key_writes,
  ].join('\n');
  return Math.max(1, estimateTokens(text));
}

export function estimateMessageTokens(message: Pick<SessionMessage, 'content'>): number {
  return Math.max(1, estimateTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
}

export function cloneSessionMessages(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((message) => ({
    ...message,
    ...(message.attachments ? { attachments: [...message.attachments] } : {}),
    ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
  }));
}

export function summarizeText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function groupMessagesIntoTurns(messages: SessionMessage[]): SessionMessage[][] {
  const normalized = cloneSessionMessages(messages).filter((message) => {
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) return false;
    return message.metadata?.compactDigest !== true;
  });
  if (normalized.length === 0) return [];

  const groups: SessionMessage[][] = [];
  let current: SessionMessage[] = [];
  for (const message of normalized) {
    if (message.role === 'user' && current.length > 0) {
      groups.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function buildDigestFromMessageGroup(group: SessionMessage[]): TaskDigest {
  const firstUser = group.find((item) => item.role === 'user');
  const lastAssistant = [...group].reverse().find((item) => item.role === 'assistant');
  const combinedText = group.map((item) => item.content).join('\n');
  const toolNames = Array.from(new Set(
    group
      .map((item) => typeof item.toolName === 'string' ? item.toolName.trim() : '')
      .filter((item) => item.length > 0),
  )).slice(0, 8);
  const keyEntities = tokenizeUserInput(combinedText).slice(0, 12);
  const topic = keyEntities.slice(0, 4).join(' ') || summarizeText(firstUser?.content ?? group[0]?.content ?? 'history digest', 80);
  const digest: TaskDigest = {
    request: summarizeText(firstUser?.content ?? group[0]?.content ?? '(no user request)', 220),
    summary: summarizeText(lastAssistant?.content ?? group[group.length - 1]?.content ?? '(no assistant summary)', 320),
    key_tools: toolNames,
    key_reads: [],
    key_writes: [],
    tags: keyEntities.slice(0, 6),
    topic,
    tokenCount: 0,
    timestamp: group[group.length - 1]?.timestamp ?? new Date().toISOString(),
    key_entities: keyEntities,
    source: 'session_snapshot',
  };
  digest.tokenCount = estimateDigestTokens(digest);
  return digest;
}

export function buildDigestsFromMessages(messages: SessionMessage[]): TaskDigest[] {
  return groupMessagesIntoTurns(messages).map((group) => buildDigestFromMessageGroup(group));
}

export function digestToSessionMessage(
  digest: TaskDigest,
  metadata: Record<string, unknown> = {},
): SessionMessage {
  const content = [
    `[context_digest] ${digest.topic || 'historical_memory'}`,
    `Request: ${digest.request}`,
    `Summary: ${digest.summary}`,
    digest.tags.length > 0 ? `Tags: ${digest.tags.join(', ')}` : '',
    digest.key_tools.length > 0 ? `Tools: ${digest.key_tools.join(', ')}` : '',
    (digest.key_entities ?? []).length > 0 ? `Entities: ${(digest.key_entities ?? []).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return {
    id: `digest-${digest.ledgerLine ?? 'session'}-${Buffer.from(`${digest.timestamp}:${digest.topic}`).toString('base64').replace(/=/g, '')}`,
    role: 'assistant',
    content,
    timestamp: digest.timestamp,
    metadata: {
      compactDigest: true,
      tokenCount: digest.tokenCount,
      tags: digest.tags,
      topic: digest.topic,
      ...(digest.ledgerLine !== undefined ? { ledgerLine: digest.ledgerLine } : {}),
      ...(digest.key_entities ? { keyEntities: digest.key_entities } : {}),
      ...metadata,
    },
  };
}

export function sessionDigestMessageToTaskDigest(message: SessionMessage): TaskDigest | null {
  if (message.metadata?.compactDigest !== true) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  const lines = content.split('\n').map((line) => line.trim());
  const takeField = (prefix: string): string => {
    const hit = lines.find((line) => line.toLowerCase().startsWith(prefix.toLowerCase()));
    return hit ? hit.slice(prefix.length).trim() : '';
  };
  const tags = takeField('Tags:').split(',').map((item) => item.trim()).filter(Boolean);
  const keyTools = takeField('Tools:').split(',').map((item) => item.trim()).filter(Boolean);
  const keyEntities = takeField('Entities:').split(',').map((item) => item.trim()).filter(Boolean);
  const topicLine = lines.find((line) => line.startsWith('[context_digest]')) ?? '';
  const topic = topicLine.replace('[context_digest]', '').trim() || takeField('Topic:');
  return {
    request: takeField('Request:') || summarizeText(content, 220),
    summary: takeField('Summary:') || summarizeText(content, 320),
    key_tools: keyTools,
    key_reads: [],
    key_writes: [],
    tags,
    topic,
    tokenCount: typeof message.metadata?.tokenCount === 'number' ? Math.max(1, Math.floor(message.metadata.tokenCount)) : estimateTokens(content),
    timestamp: message.timestamp,
    ledgerLine: typeof message.metadata?.ledgerLine === 'number' ? Math.floor(message.metadata.ledgerLine) : undefined,
    key_entities: keyEntities,
    source: 'session_digest_message',
  };
}

export function selectTailMessagesWithinBudget(
  messages: SessionMessage[],
  budgetTokens: number,
): { messages: SessionMessage[]; startIndex: number; totalTokens: number } {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], startIndex: 0, totalTokens: 0 };
  }
  const selected: SessionMessage[] = [];
  let totalTokens = 0;
  let startIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const tokenCount = estimateMessageTokens(message);
    if (selected.length > 0 && totalTokens + tokenCount > budgetTokens) break;
    selected.unshift({
      ...message,
      ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
    });
    totalTokens += tokenCount;
    startIndex = index;
  }
  return { messages: selected, startIndex, totalTokens };
}

export function selectNewestDigestsWithinBudget(digests: TaskDigest[], budgetTokens: number): TaskDigest[] {
  const sorted = [...digests].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const selected: TaskDigest[] = [];
  let totalTokens = 0;
  for (const digest of sorted) {
    const tokenCount = Math.max(1, digest.tokenCount || estimateDigestTokens(digest));
    if (selected.length > 0 && totalTokens + tokenCount > budgetTokens) break;
    selected.push({ ...digest, tokenCount });
    totalTokens += tokenCount;
  }
  return sortByTimeAscending(selected);
}

export function sortByTimeAscending<T extends { timestamp: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

export function sortByRelevanceDescending(results: SearchResult[]): SearchResult[] {
  return [...results].sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    return new Date(b.digest.timestamp).getTime() - new Date(a.digest.timestamp).getTime();
  });
}

export function filterByRelevanceThreshold(results: SearchResult[], threshold: number): SearchResult[] {
  return results.filter((item) => item.relevance >= threshold);
}

export function takeTopPercent(results: SearchResult[], percent: number): SearchResult[] {
  if (results.length === 0) return [];
  const count = Math.max(1, Math.ceil(results.length * percent));
  return results.slice(0, count);
}

export function validateTokenBudget(
  messages: SessionMessage[],
  budgetTokens: number,
): { ok: boolean; actualTokens: number; overflow: number } {
  const actualTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const overflow = Math.max(0, actualTokens - budgetTokens);
  return {
    ok: overflow === 0,
    actualTokens,
    overflow,
  };
}

export function getRecentRounds(messages: SessionMessage[], rounds: number): SessionMessage[] {
  if (!Array.isArray(messages) || messages.length === 0 || rounds <= 0) return [];
  const groups = groupMessagesIntoTurns(messages);
  return groups.slice(-rounds).flat();
}

export function dedupeDigestsBySignature(digests: TaskDigest[]): TaskDigest[] {
  const seen = new Set<string>();
  const output: TaskDigest[] = [];
  for (const digest of sortByTimeAscending(digests)) {
    const signature = [digest.request, digest.summary, digest.topic, digest.timestamp].join('||');
    if (seen.has(signature)) continue;
    seen.add(signature);
    output.push({ ...digest, tokenCount: Math.max(1, digest.tokenCount || estimateDigestTokens(digest)) });
  }
  return output;
}
