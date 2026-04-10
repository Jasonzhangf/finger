import type { RuntimeFacade } from '../../runtime/runtime-facade.js';

interface SessionMessageLike {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

interface ContextBuildMessageLike {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestampIso: string;
  messageId?: string;
  metadata?: Record<string, unknown>;
  attachments?: {
    count: number;
    summary: string;
  };
  contextZone?: 'working_set' | 'historical_memory';
}

export interface PersistedContextBuilderHistoryIndex {
  version: 1;
  source: string;
  buildMode: 'minimal' | 'moderate' | 'aggressive';
  targetBudget: number;
  selectedBlockIds: string[];
  selectedMessageIds: string[];
  historySelectedMessageIds?: string[];
  currentContextMessageIds?: string[];
  pinnedMessageIds?: string[];
  currentContextMaxItems?: number;
  anchorMessageId?: string;
  anchorTimestamp?: string;
  historicalDigestMessages?: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
  updatedAt: string;
}

const DEFAULT_CURRENT_CONTEXT_MAX_ITEMS = 240;
const DEFAULT_RECENT_USER_TURN_COUNT = 2;
const DEFAULT_SYSTEM_ONLY_TASK_GAP_MS = 3 * 60 * 1000;

function messageIdentity(item: SessionMessageLike): string {
  return typeof item.id === 'string' && item.id.trim().length > 0
    ? item.id
    : `${item.role}:${item.timestamp ?? ''}:${item.content.slice(0, 32)}`;
}

function extractRecentTurnWindow(
  sessionMessages: SessionMessageLike[],
  recentUserTurnCount = DEFAULT_RECENT_USER_TURN_COUNT,
): SessionMessageLike[] {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return [];
  let remainingUserTurns = Math.max(1, Math.floor(recentUserTurnCount));
  let startIndex = 0;
  for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
    const item = sessionMessages[index];
    if (item.role === 'user' && typeof item.content === 'string' && item.content.trim().length > 0) {
      remainingUserTurns -= 1;
      if (remainingUserTurns === 0) {
        startIndex = index;
        break;
      }
    }
  }
  return sessionMessages.slice(startIndex);
}

function normalizeSessionMessageTimestampMs(item: SessionMessageLike, fallback = Date.now()): number {
  const raw = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
  return Number.isFinite(raw) ? raw : fallback;
}

function extractDispatchId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const candidates = [metadata.dispatchId, metadata.dispatch_id, metadata.dispatch_id_v2];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim().length > 0) {
      return item.trim();
    }
  }
  return undefined;
}

function isReasoningStopBoundary(message: SessionMessageLike): boolean {
  const metadata = message.metadata;
  if (metadata && typeof metadata === 'object') {
    const toolName = metadata.toolName;
    if (typeof toolName === 'string' && toolName.trim() === 'reasoning.stop') return true;
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return false;
  return /\breasoning\.stop\b/i.test(content);
}

interface SessionTaskBlockLike {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  messages: SessionMessageLike[];
}

function groupSessionMessagesByTaskBoundary(sessionMessages: SessionMessageLike[]): SessionTaskBlockLike[] {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return [];
  const hasUserBoundary = sessionMessages.some(
    (item) => item.role === 'user' && typeof item.content === 'string' && item.content.trim().length > 0,
  );
  const blocks: SessionTaskBlockLike[] = [];
  let current: SessionMessageLike[] = [];
  let blockStartMs = 0;
  let currentDispatchId: string | undefined;
  let previousTs = 0;
  for (const item of sessionMessages) {
    if (current.length === 0) {
      blockStartMs = normalizeSessionMessageTimestampMs(item);
      previousTs = blockStartMs;
    }
    const isUser = item.role === 'user';
    const itemTs = normalizeSessionMessageTimestampMs(item, previousTs);
    const dispatchId = extractDispatchId(item.metadata);
    const dispatchChanged = !hasUserBoundary && !!dispatchId && !!currentDispatchId && dispatchId !== currentDispatchId;
    const gapBoundary = !hasUserBoundary && current.length > 0 && Math.max(0, itemTs - previousTs) > DEFAULT_SYSTEM_ONLY_TASK_GAP_MS;
    if (current.length > 0 && ((hasUserBoundary && isUser) || dispatchChanged || gapBoundary)) {
      const endTimeMs = normalizeSessionMessageTimestampMs(current[current.length - 1], blockStartMs);
      blocks.push({
        id: `task-${blockStartMs}`,
        startTimeMs: blockStartMs,
        endTimeMs,
        messages: current,
      });
      current = [];
      currentDispatchId = undefined;
      blockStartMs = normalizeSessionMessageTimestampMs(item, endTimeMs);
    }
    current.push(item);
    if (isReasoningStopBoundary(item)) {
      const endTimeMs = normalizeSessionMessageTimestampMs(current[current.length - 1], blockStartMs);
      blocks.push({
        id: `task-${blockStartMs}`,
        startTimeMs: blockStartMs,
        endTimeMs,
        messages: current,
      });
      current = [];
      currentDispatchId = undefined;
      continue;
    }
    if (!currentDispatchId && dispatchId) currentDispatchId = dispatchId;
    previousTs = itemTs;
  }
  if (current.length > 0) {
    const endTimeMs = normalizeSessionMessageTimestampMs(current[current.length - 1], blockStartMs);
    blocks.push({
      id: `task-${blockStartMs}`,
      startTimeMs: blockStartMs,
      endTimeMs,
      messages: current,
    });
  }
  return blocks;
}

function compactContent(input: string, limit: number): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}...`;
}

function synthesizeDigestMessageFromTaskBlock(block: SessionTaskBlockLike): SessionMessageLike {
  const firstUser = block.messages.find((message) => message.role === 'user')?.content ?? '';
  const lastAssistant = [...block.messages].reverse().find((message) => message.role === 'assistant')?.content ?? '';
  const toolNames = Array.from(new Set(
    block.messages
      .map((message) => {
        const metadata = message.metadata;
        if (!metadata || typeof metadata !== 'object') return '';
        const name = metadata.toolName;
        return typeof name === 'string' && name.trim().length > 0 ? name.trim() : '';
      })
      .filter((name) => name.length > 0),
  )).slice(0, 8);
  const parts = [
    firstUser.trim().length > 0 ? `请求: ${compactContent(firstUser, 220)}` : '',
    lastAssistant.trim().length > 0 ? `结果: ${compactContent(lastAssistant, 260)}` : '',
    toolNames.length > 0 ? `工具: ${toolNames.join(', ')}` : '',
  ].filter((part) => part.length > 0);
  const digestId = `digest-${block.id}`;
  const digestContent = parts.length > 0 ? parts.join('\n') : `(task digest ${block.id})`;
  return {
    id: digestId,
    role: 'assistant',
    content: digestContent,
    timestamp: new Date(block.endTimeMs).toISOString(),
    metadata: {
      compactDigest: true,
      compactDigestFromTaskId: block.id,
      messageId: digestId,
      contextZone: 'historical_memory',
    },
  };
}

function buildSyntheticDigestById(sessionMessages: SessionMessageLike[]): Map<string, SessionMessageLike> {
  const map = new Map<string, SessionMessageLike>();
  for (const block of groupSessionMessagesByTaskBoundary(sessionMessages)) {
    const digest = synthesizeDigestMessageFromTaskBlock(block);
    if (typeof digest.id === 'string' && digest.id.trim().length > 0) {
      map.set(digest.id, digest);
    }
  }
  return map;
}

export function readPersistedContextBuilderHistoryIndex(
  sessionContext: Record<string, unknown> | undefined,
): PersistedContextBuilderHistoryIndex | null {
  const raw = sessionContext?.contextBuilderHistoryIndex;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const selectedMessageIds = Array.isArray(value.selectedMessageIds)
    ? value.selectedMessageIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (selectedMessageIds.length === 0) return null;
  const buildMode = value.buildMode === 'minimal' || value.buildMode === 'moderate' || value.buildMode === 'aggressive'
    ? value.buildMode
    : 'moderate';
  const targetBudget = typeof value.targetBudget === 'number' && Number.isFinite(value.targetBudget) && value.targetBudget > 0
    ? Math.floor(value.targetBudget)
    : 20000;
  const selectedBlockIds = Array.isArray(value.selectedBlockIds)
    ? value.selectedBlockIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const historySelectedMessageIds = Array.isArray(value.historySelectedMessageIds)
    ? value.historySelectedMessageIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const currentContextMessageIds = Array.isArray(value.currentContextMessageIds)
    ? value.currentContextMessageIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const pinnedMessageIds = Array.isArray(value.pinnedMessageIds)
    ? value.pinnedMessageIds.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const currentContextMaxItems = typeof value.currentContextMaxItems === 'number' && Number.isFinite(value.currentContextMaxItems) && value.currentContextMaxItems > 0
    ? Math.floor(value.currentContextMaxItems)
    : DEFAULT_CURRENT_CONTEXT_MAX_ITEMS;
  const anchorMessageId = typeof value.anchorMessageId === 'string' && value.anchorMessageId.trim().length > 0
    ? value.anchorMessageId
    : undefined;
  const anchorTimestamp = typeof value.anchorTimestamp === 'string' && value.anchorTimestamp.trim().length > 0
    ? value.anchorTimestamp
    : undefined;
  const historicalDigestMessages = Array.isArray(value.historicalDigestMessages)
    ? value.historicalDigestMessages
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => {
        const id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : '';
        const content = typeof item.content === 'string' ? item.content : '';
        if (!id || content.trim().length === 0) return null;
        const role: 'user' | 'assistant' | 'system' = item.role === 'assistant' || item.role === 'system'
          ? item.role
          : 'user';
        const timestamp = typeof item.timestamp === 'string' && item.timestamp.trim().length > 0
          ? item.timestamp
          : new Date().toISOString();
        const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
          ? item.metadata as Record<string, unknown>
          : undefined;
        return {
          id,
          role,
          content,
          timestamp,
          ...(metadata ? { metadata } : {}),
        };
      })
      .filter((item): item is {
        id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        timestamp: string;
        metadata?: Record<string, unknown>;
      } => !!item)
    : undefined;

  return {
    version: 1,
    source: typeof value.source === 'string' && value.source.trim().length > 0 ? value.source : 'context_builder_indexed',
    buildMode,
    targetBudget,
    selectedBlockIds,
    selectedMessageIds,
    ...(historySelectedMessageIds && historySelectedMessageIds.length > 0 ? { historySelectedMessageIds } : {}),
    ...(currentContextMessageIds && currentContextMessageIds.length > 0 ? { currentContextMessageIds } : {}),
    ...(pinnedMessageIds && pinnedMessageIds.length > 0 ? { pinnedMessageIds } : {}),
    currentContextMaxItems,
    ...(anchorMessageId ? { anchorMessageId } : {}),
    ...(anchorTimestamp ? { anchorTimestamp } : {}),
    ...(historicalDigestMessages && historicalDigestMessages.length > 0 ? { historicalDigestMessages } : {}),
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt.trim().length > 0
      ? value.updatedAt
      : new Date().toISOString(),
  };
}

export function buildContextBuilderHistoryIndex(
  source: string,
  buildMode: 'minimal' | 'moderate' | 'aggressive',
  targetBudget: number,
  selectedBlockIds: string[],
  messages: ContextBuildMessageLike[],
  options?: {
    pinnedMessageIds?: string[];
    currentContextMaxItems?: number;
  },
): PersistedContextBuilderHistoryIndex {
  const selectedMessageIdsRaw = messages
    .map((message) => (typeof message.messageId === 'string' && message.messageId.trim().length > 0 ? message.messageId : message.id))
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
  const historySelectedMessageIdsRaw = messages
    .filter((message) => message.contextZone === 'historical_memory')
    .map((message) => (typeof message.messageId === 'string' && message.messageId.trim().length > 0 ? message.messageId : message.id))
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
  let historySelectedMessageIds = historySelectedMessageIdsRaw.length > 0
    ? historySelectedMessageIdsRaw
    : selectedMessageIdsRaw;
  const currentContextMessageIds = messages
    .filter((message) => message.contextZone !== 'historical_memory')
    .map((message) => (typeof message.messageId === 'string' && message.messageId.trim().length > 0 ? message.messageId : message.id))
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
  let historicalDigestMessages = messages
    .filter((message) => {
      if (message.contextZone !== 'historical_memory') return false;
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content) return false;
      const compact = message.metadata && typeof message.metadata === 'object'
        ? message.metadata.compactDigest === true
        : false;
      const messageId = typeof message.messageId === 'string' && message.messageId.trim().length > 0
        ? message.messageId
        : message.id;
      return compact || messageId.startsWith('digest-');
    })
    .map((message) => {
      const id = typeof message.messageId === 'string' && message.messageId.trim().length > 0
        ? message.messageId
        : message.id;
      const role: 'user' | 'assistant' | 'system' = message.role === 'assistant' || message.role === 'system'
        ? message.role
        : 'user';
      const metadata = message.metadata && typeof message.metadata === 'object'
        ? { ...message.metadata, contextZone: 'historical_memory' }
        : { contextZone: 'historical_memory' };
      return {
        id,
        role,
        content: message.content,
        timestamp: message.timestampIso,
        metadata,
      };
    });
  if (historicalDigestMessages.length === 0) {
    const historicalMessages = messages
      .filter((message) => message.contextZone === 'historical_memory')
      .map((message) => ({
        id: typeof message.messageId === 'string' && message.messageId.trim().length > 0
          ? message.messageId
          : message.id,
        role: message.role,
        content: message.content,
        timestamp: message.timestampIso,
        ...(message.metadata ? { metadata: { ...message.metadata } } : {}),
      } satisfies SessionMessageLike));
    if (historicalMessages.length > 0) {
      historicalDigestMessages = groupSessionMessagesByTaskBoundary(historicalMessages)
        .map((block) => synthesizeDigestMessageFromTaskBlock(block))
        .map((digest) => ({
          id: digest.id ?? `digest-${Date.now()}`,
          role: digest.role === 'assistant' || digest.role === 'system' ? digest.role : 'assistant',
          content: digest.content,
          timestamp: digest.timestamp ?? new Date().toISOString(),
          metadata: {
            ...(digest.metadata ?? {}),
            contextZone: 'historical_memory',
            compactDigest: true,
          },
        }));
    }
  }
  if (historicalDigestMessages.length > 0) {
    historySelectedMessageIds = historicalDigestMessages.map((item) => item.id);
  }
  const selectedMessageIds = Array.from(new Set([
    ...historySelectedMessageIds,
    ...currentContextMessageIds,
  ]));
  const pinnedMessageIds = (options?.pinnedMessageIds ?? [])
    .filter((item) => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item, index, arr) => arr.indexOf(item) === index);
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const anchorMessageId = last
    ? (typeof last.messageId === 'string' && last.messageId.trim().length > 0 ? last.messageId : last.id)
    : undefined;
  const anchorTimestamp = last?.timestampIso;
  return {
    version: 1,
    source,
    buildMode,
    targetBudget: Math.max(1, Math.floor(targetBudget)),
    selectedBlockIds,
    selectedMessageIds,
    ...(historySelectedMessageIds.length > 0 ? { historySelectedMessageIds } : {}),
    ...(currentContextMessageIds.length > 0 ? { currentContextMessageIds } : {}),
    ...(pinnedMessageIds.length > 0 ? { pinnedMessageIds } : {}),
    currentContextMaxItems: Number.isFinite(options?.currentContextMaxItems)
      ? Math.max(1, Math.floor(options?.currentContextMaxItems as number))
      : DEFAULT_CURRENT_CONTEXT_MAX_ITEMS,
    ...(anchorMessageId ? { anchorMessageId } : {}),
    ...(anchorTimestamp ? { anchorTimestamp } : {}),
    ...(historicalDigestMessages.length > 0 ? { historicalDigestMessages } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export function persistContextBuilderHistoryIndex(
  runtime: RuntimeFacade,
  sessionId: string,
  index: PersistedContextBuilderHistoryIndex,
): void {
  runtime.updateSessionContext(sessionId, {
    contextBuilderHistoryIndex: index,
  });
}

export function buildIndexedHistoryFromSnapshot(
  sessionMessages: SessionMessageLike[],
  index: PersistedContextBuilderHistoryIndex,
  limit: number,
): {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>;
  selectedCount: number;
  deltaCount: number;
  requestedHistoricalCount: number;
  resolvedHistoricalCount: number;
  missingHistoricalCount: number;
} | null {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return null;

  const byId = new Map<string, SessionMessageLike>();
  for (const message of sessionMessages) {
    if (typeof message.id === 'string' && message.id.trim().length > 0) {
      byId.set(message.id, message);
    }
  }
  const syntheticDigestById = buildSyntheticDigestById(sessionMessages);
  const persistedDigestById = new Map<string, SessionMessageLike>();
  for (const item of index.historicalDigestMessages ?? []) {
    persistedDigestById.set(item.id, {
      id: item.id,
      role: item.role,
      content: item.content,
      timestamp: item.timestamp,
      ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
    });
  }

  const historySelectedMessageIds = (index.historySelectedMessageIds && index.historySelectedMessageIds.length > 0)
    ? index.historySelectedMessageIds
    : index.selectedMessageIds;
  const currentContextMessageIds = index.currentContextMessageIds ?? [];
  const historySelectedSet = new Set(historySelectedMessageIds);
  const currentContextSet = new Set(currentContextMessageIds);
  const pinnedMessageIds = index.pinnedMessageIds ?? [];
  const recentTurnWindow = extractRecentTurnWindow(sessionMessages);
  const recentTurnIds = new Set(recentTurnWindow.map((item) => messageIdentity(item)));
  const selected = [
    ...pinnedMessageIds,
    ...historySelectedMessageIds,
    ...currentContextMessageIds,
  ]
    .map((id) => byId.get(id) ?? persistedDigestById.get(id) ?? syntheticDigestById.get(id))
    .filter((item): item is SessionMessageLike => !!item);
  const selectedHistoryCount = selected.filter((item) => {
    const key = messageIdentity(item);
    return historySelectedSet.has(key);
  }).length;
  const requestedHistoricalCount = historySelectedSet.size;
  const resolvedHistoricalCount = selectedHistoryCount;
  const missingHistoricalCount = Math.max(0, requestedHistoricalCount - resolvedHistoricalCount);
  if (selectedHistoryCount === 0 && historySelectedSet.size > 0 && syntheticDigestById.size > 0) {
    const fallbackDigests = Array.from(syntheticDigestById.values())
      .slice(-Math.min(12, syntheticDigestById.size))
      .map((item) => ({
        ...item,
        metadata: {
          ...(item.metadata ?? {}),
          contextZone: 'historical_memory',
          compactDigest: true,
          contextBuilderAutoDigest: true,
        },
      }));
    selected.push(...fallbackDigests);
  }

  let deltaStart = -1;
  if (index.anchorMessageId) {
    deltaStart = sessionMessages.findIndex((item) => item.id === index.anchorMessageId);
  }
  if (deltaStart < 0 && index.anchorTimestamp) {
    const anchorMs = Date.parse(index.anchorTimestamp);
    if (Number.isFinite(anchorMs)) {
      deltaStart = sessionMessages.findIndex((item) => {
        const ts = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : NaN;
        return Number.isFinite(ts) && ts > anchorMs;
      });
      if (deltaStart > 0) deltaStart -= 1;
    }
  }
  const delta = deltaStart >= 0
    ? sessionMessages.slice(deltaStart + 1)
    : [];

  const seenIds = new Set<string>();
  const prioritizedHistorical: SessionMessageLike[] = [];
  const recentPreserved: SessionMessageLike[] = [];
  const deltaMerged: SessionMessageLike[] = [];
  const pushUnique = (item: SessionMessageLike): void => {
    const key = messageIdentity(item);
    if (seenIds.has(key)) return;
    seenIds.add(key);
    if (recentTurnIds.has(key)) {
      recentPreserved.push(item);
      return;
    }
    prioritizedHistorical.push(item);
  };

  for (const item of selected) pushUnique(item);
  for (const item of delta) {
    const key = messageIdentity(item);
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    deltaMerged.push(item);
  }
  const merged = [...prioritizedHistorical, ...recentPreserved, ...deltaMerged];
  if (merged.length === 0) return null;

  let sliced = merged;
  if (Number.isFinite(limit) && limit > 0) {
    const mustKeep = [...recentPreserved, ...deltaMerged];
    const mustKeepKeys = new Set(mustKeep.map((item) => messageIdentity(item)));
    const dedupMustKeep = mustKeep.filter((item, index, arr) => arr.findIndex((candidate) => messageIdentity(candidate) === messageIdentity(item)) === index);
    if (dedupMustKeep.length >= limit) {
      sliced = dedupMustKeep.slice(-limit);
    } else {
      const remaining = limit - dedupMustKeep.length;
      const historicalPool = prioritizedHistorical.filter((item) => !mustKeepKeys.has(messageIdentity(item)));
      sliced = [...historicalPool.slice(-remaining), ...dedupMustKeep];
    }
  }
  const slicedChronological = [...sliced].sort((a, b) => {
    const aMs = normalizeSessionMessageTimestampMs(a);
    const bMs = normalizeSessionMessageTimestampMs(b);
    if (aMs !== bMs) return aMs - bMs;
    return messageIdentity(a).localeCompare(messageIdentity(b));
  });

  const mapped = slicedChronological
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, idx) => {
      const role: 'user' | 'assistant' | 'system' = item.role === 'assistant' || item.role === 'system'
        ? item.role
        : 'user';
      const messageId = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : undefined;
      const inferredContextZone = messageId
        ? (historySelectedSet.has(messageId)
          ? 'historical_memory'
          : currentContextSet.has(messageId)
            ? 'working_set'
            : undefined)
        : undefined;
      const metadata = item.metadata && typeof item.metadata === 'object'
        ? { ...item.metadata }
        : {};
      if (!metadata.contextZone && inferredContextZone) {
        metadata.contextZone = inferredContextZone;
      }
      return {
        id: item.id ?? `ctx-indexed-${Date.now()}-${idx}`,
        role,
        content: item.content,
        timestamp: item.timestamp ?? new Date().toISOString(),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    });

  if (mapped.length === 0) return null;
  return {
    messages: mapped,
    selectedCount: prioritizedHistorical.length + recentPreserved.length,
    deltaCount: Math.max(0, deltaMerged.length),
    requestedHistoricalCount,
    resolvedHistoricalCount,
    missingHistoricalCount,
  };
}

export function extractPinnedMessageIdsFromSessionContext(
  sessionContext: Record<string, unknown> | undefined,
): string[] {
  const raw = sessionContext?.contextBuilderPinnedMessageIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

export function buildNextIndexedHistoryIndex(
  previous: PersistedContextBuilderHistoryIndex,
  mergedMessages: Array<{
    id: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }>,
): PersistedContextBuilderHistoryIndex {
  const historySelectedMessageIds = previous.historySelectedMessageIds && previous.historySelectedMessageIds.length > 0
    ? previous.historySelectedMessageIds
    : previous.selectedMessageIds;
  const historySet = new Set(historySelectedMessageIds);
  const allIds = mergedMessages
    .map((message) => {
      const metadataMessageId = typeof message.metadata?.messageId === 'string' && message.metadata.messageId.trim().length > 0
        ? message.metadata.messageId
        : undefined;
      return metadataMessageId ?? message.id;
    })
    .filter((item) => typeof item === 'string' && item.trim().length > 0);
  const currentRaw = allIds.filter((item) => !historySet.has(item));
  const rawMaxCurrent = previous.currentContextMaxItems;
  const maxCurrent = typeof rawMaxCurrent === 'number' && Number.isFinite(rawMaxCurrent) && rawMaxCurrent > 0
    ? Math.floor(rawMaxCurrent)
    : DEFAULT_CURRENT_CONTEXT_MAX_ITEMS;
  const currentContextMessageIds = currentRaw.length > maxCurrent
    ? currentRaw.slice(-maxCurrent)
    : currentRaw;
  const selectedMessageIds = Array.from(new Set([...historySelectedMessageIds, ...currentContextMessageIds]));
  const last = mergedMessages.length > 0 ? mergedMessages[mergedMessages.length - 1] : undefined;
  const anchorMessageId = last
    ? (typeof last.metadata?.messageId === 'string' && last.metadata.messageId.trim().length > 0
      ? last.metadata.messageId
      : last.id)
    : previous.anchorMessageId;
  const anchorTimestamp = last?.timestamp ?? previous.anchorTimestamp;
  return {
    version: 1,
    source: 'context_builder_indexed',
    buildMode: previous.buildMode,
    targetBudget: previous.targetBudget,
    selectedBlockIds: previous.selectedBlockIds,
    selectedMessageIds,
    historySelectedMessageIds,
    currentContextMessageIds,
    ...(previous.pinnedMessageIds && previous.pinnedMessageIds.length > 0 ? { pinnedMessageIds: previous.pinnedMessageIds } : {}),
    currentContextMaxItems: maxCurrent,
    ...(anchorMessageId ? { anchorMessageId } : {}),
    ...(anchorTimestamp ? { anchorTimestamp } : {}),
    ...(previous.historicalDigestMessages && previous.historicalDigestMessages.length > 0
      ? { historicalDigestMessages: previous.historicalDigestMessages }
      : {}),
    updatedAt: new Date().toISOString(),
  };
}
