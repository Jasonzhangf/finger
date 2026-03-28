export const DEFAULT_RECENT_TASK_COUNT = 2;
export const DEFAULT_RECENT_USER_INPUT_COUNT = 10;

export type SessionHistoryMessage = {
  id?: string;
  role: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export type MappedHistoryMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

export function sessionMessageIdentity(message: SessionHistoryMessage | MappedHistoryMessage): string {
  if (typeof message.id === 'string' && message.id.trim().length > 0) {
    return message.id.trim();
  }
  return `${message.role}:${message.timestamp ?? ''}:${message.content.slice(0, 48)}`;
}

export function extractRecentTaskMessages(
  sessionMessages: SessionHistoryMessage[],
  taskCount = DEFAULT_RECENT_TASK_COUNT,
): SessionHistoryMessage[] {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return [];
  let remainingUserTurns = Math.max(1, Math.floor(taskCount));
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

export function extractRecentUserInputs(
  sessionMessages: SessionHistoryMessage[],
  inputCount = DEFAULT_RECENT_USER_INPUT_COUNT,
): SessionHistoryMessage[] {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return [];
  return sessionMessages
    .filter((item) => item.role === 'user' && typeof item.content === 'string' && item.content.trim().length > 0)
    .slice(-Math.max(1, Math.floor(inputCount)));
}

export function augmentHistoryWithContinuityAnchors(
  selectedMessages: MappedHistoryMessage[],
  sessionMessages: SessionHistoryMessage[],
  limit: number,
  extraMetadata?: Record<string, unknown>,
): MappedHistoryMessage[] {
  if (!Array.isArray(selectedMessages) || selectedMessages.length === 0) {
    return selectedMessages;
  }

  const recentTaskMessages = extractRecentTaskMessages(sessionMessages);
  const recentUserInputs = extractRecentUserInputs(sessionMessages);
  const requiredOrder = [...recentTaskMessages, ...recentUserInputs];
  const requiredMetaById = new Map<string, { continuityAnchorTypes: string[] }>();

  for (const item of recentTaskMessages) {
    const key = sessionMessageIdentity(item);
    const current = requiredMetaById.get(key) ?? { continuityAnchorTypes: [] };
    if (!current.continuityAnchorTypes.includes('recent_task')) current.continuityAnchorTypes.push('recent_task');
    requiredMetaById.set(key, current);
  }
  for (const item of recentUserInputs) {
    const key = sessionMessageIdentity(item);
    const current = requiredMetaById.get(key) ?? { continuityAnchorTypes: [] };
    if (!current.continuityAnchorTypes.includes('recent_user_input')) current.continuityAnchorTypes.push('recent_user_input');
    requiredMetaById.set(key, current);
  }

  const allById = new Map<string, MappedHistoryMessage>();
  for (const item of selectedMessages) {
    allById.set(sessionMessageIdentity(item), item);
  }

  for (const item of requiredOrder) {
    const key = sessionMessageIdentity(item);
    if (allById.has(key)) continue;
    allById.set(key, {
      id: item.id ?? `continuity-${Date.now()}-${allById.size}`,
      role: item.role === 'assistant' || item.role === 'system' ? item.role : 'user',
      content: item.content,
      timestamp: item.timestamp ?? new Date().toISOString(),
      ...((item.metadata && typeof item.metadata === 'object') || (extraMetadata && typeof extraMetadata === 'object')
        ? { metadata: { ...(item.metadata ?? {}), ...(extraMetadata ?? {}) } }
        : {}),
    });
  }

  const orderedIds: string[] = [];
  const orderedIdSet = new Set<string>();
  for (const item of sessionMessages) {
    const key = sessionMessageIdentity(item);
    if (!allById.has(key) || orderedIdSet.has(key)) continue;
    orderedIdSet.add(key);
    orderedIds.push(key);
  }
  for (const item of selectedMessages) {
    const key = sessionMessageIdentity(item);
    if (orderedIdSet.has(key)) continue;
    orderedIdSet.add(key);
    orderedIds.push(key);
  }

  const requiredKeys = new Set(Array.from(requiredMetaById.keys()));
  let finalIds = orderedIds.slice();
  if (Number.isFinite(limit) && limit > 0 && finalIds.length > limit) {
    if (requiredKeys.size >= limit) {
      finalIds = finalIds.filter((id) => requiredKeys.has(id)).slice(-limit);
    } else {
      const preserved = finalIds.filter((id) => requiredKeys.has(id));
      const preservedSet = new Set(preserved);
      const remaining = limit - preserved.length;
      const nonRequiredTail = finalIds.filter((id) => !preservedSet.has(id)).slice(-remaining);
      finalIds = [...nonRequiredTail, ...preserved];
    }
  }

  return finalIds
    .map((id) => {
      const base = allById.get(id);
      if (!base) return null;
      const anchorMeta = requiredMetaById.get(id);
      if (!anchorMeta) return base;
      return {
        ...base,
        metadata: {
          ...(base.metadata ?? {}),
          ...(extraMetadata ?? {}),
          continuityAnchor: true,
          continuityAnchorTypes: anchorMeta.continuityAnchorTypes,
        },
      };
    })
    .filter((item): item is MappedHistoryMessage => !!item);
}
