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
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
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
  updatedAt: string;
}

const DEFAULT_CURRENT_CONTEXT_MAX_ITEMS = 240;
const DEFAULT_RECENT_USER_TURN_COUNT = 2;

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
  const historySelectedMessageIds = historySelectedMessageIdsRaw.length > 0
    ? historySelectedMessageIdsRaw
    : selectedMessageIdsRaw;
  const currentContextMessageIds = messages
    .filter((message) => message.contextZone !== 'historical_memory')
    .map((message) => (typeof message.messageId === 'string' && message.messageId.trim().length > 0 ? message.messageId : message.id))
    .filter((item, index, arr) => item.length > 0 && arr.indexOf(item) === index);
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
} | null {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return null;

  const byId = new Map<string, SessionMessageLike>();
  for (const message of sessionMessages) {
    if (typeof message.id === 'string' && message.id.trim().length > 0) {
      byId.set(message.id, message);
    }
  }

  const historySelectedMessageIds = (index.historySelectedMessageIds && index.historySelectedMessageIds.length > 0)
    ? index.historySelectedMessageIds
    : index.selectedMessageIds;
  const currentContextMessageIds = index.currentContextMessageIds ?? [];
  const pinnedMessageIds = index.pinnedMessageIds ?? [];
  const recentTurnWindow = extractRecentTurnWindow(sessionMessages);
  const recentTurnIds = new Set(recentTurnWindow.map((item) => messageIdentity(item)));
  const selected = [
    ...pinnedMessageIds,
    ...historySelectedMessageIds,
    ...currentContextMessageIds,
  ]
    .map((id) => byId.get(id))
    .filter((item): item is SessionMessageLike => !!item);

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
  const mapped = sliced
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, idx) => {
      const role: 'user' | 'assistant' | 'system' = item.role === 'assistant' || item.role === 'system'
        ? item.role
        : 'user';
      return {
        id: item.id ?? `ctx-indexed-${Date.now()}-${idx}`,
        role,
        content: item.content,
        timestamp: item.timestamp ?? new Date().toISOString(),
        ...(item.metadata && typeof item.metadata === 'object' ? { metadata: item.metadata } : {}),
      };
    });

  if (mapped.length === 0) return null;
  return {
    messages: mapped,
    selectedCount: prioritizedHistorical.length + recentPreserved.length,
    deltaCount: Math.max(0, deltaMerged.length),
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
    updatedAt: new Date().toISOString(),
  };
}
