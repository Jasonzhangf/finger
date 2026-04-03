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

const STOP_TOOL_NAME = 'reasoning.stop';
const STOP_CALL_PATTERN = /(调用工具|call(?:ing)?\s+tool|tool\s+call(?:ed)?|invok(?:e|ing)\s+tool)\s*:?\s*reasoning\.stop\b/i;
const STOP_COMPLETE_PATTERN = /(工具完成|tool\s+(?:completed|finished|result))\s*:?\s*reasoning\.stop\b/i;

export function sessionMessageIdentity(message: SessionHistoryMessage | MappedHistoryMessage): string {
  if (typeof message.id === 'string' && message.id.trim().length > 0) {
    return message.id.trim();
  }
  return `${message.role}:${message.timestamp ?? ''}:${message.content.slice(0, 48)}`;
}

function normalizeToolName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasStopToolInMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const directTool = normalizeToolName(metadata.toolName ?? metadata.tool);
  if (directTool === STOP_TOOL_NAME) return true;

  if (metadata.stopReasoningCalled === true || metadata.stop_reasoning_called === true) {
    return true;
  }

  const toolTrace = Array.isArray(metadata.tool_trace)
    ? metadata.tool_trace
    : Array.isArray(metadata.toolTrace)
      ? metadata.toolTrace
      : [];
  return toolTrace.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const tool = normalizeToolName((entry as Record<string, unknown>).tool);
    return tool === STOP_TOOL_NAME;
  });
}

function resolveStopMarkerType(message: SessionHistoryMessage): 'call' | 'complete' | null {
  if (hasStopToolInMetadata(message.metadata)) return 'call';
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  if (!content) return null;
  if (STOP_CALL_PATTERN.test(content)) return 'call';
  if (STOP_COMPLETE_PATTERN.test(content)) return 'complete';
  return null;
}

function extractRecentByUserTurns(
  sessionMessages: SessionHistoryMessage[],
  taskCount: number,
): SessionHistoryMessage[] {
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

export function extractRecentTaskMessages(
  sessionMessages: SessionHistoryMessage[],
  taskCount = DEFAULT_RECENT_TASK_COUNT,
): SessionHistoryMessage[] {
  if (!Array.isArray(sessionMessages) || sessionMessages.length === 0) return [];
  const requestedTaskCount = Math.max(1, Math.floor(taskCount));
  const hasUserTurns = sessionMessages.some((item) =>
    item.role === 'user'
    && typeof item.content === 'string'
    && item.content.trim().length > 0,
  );

  // 用户会话优先使用 user-turn 连续窗口，确保“用户提问 + 助手最终回复”
  // 不会被 reasoning.stop 边界截断（这是连续性丢失的根因之一）。
  if (hasUserTurns) {
    return extractRecentByUserTurns(sessionMessages, requestedTaskCount);
  }

  // 无 user 边界（如系统控制流）时，才退回 stop 边界窗口。
  const callMarkers: number[] = [];
  const completionMarkers: number[] = [];
  for (let index = 0; index < sessionMessages.length; index += 1) {
    const markerType = resolveStopMarkerType(sessionMessages[index]);
    if (markerType === 'call') callMarkers.push(index);
    if (markerType === 'complete') completionMarkers.push(index);
  }
  const completionBoundaries = callMarkers.length > 0 ? callMarkers : completionMarkers;
  if (completionBoundaries.length === 0) {
    return extractRecentByUserTurns(sessionMessages, requestedTaskCount);
  }

  const lastBoundaryIndex = completionBoundaries[completionBoundaries.length - 1];
  if (!Number.isFinite(lastBoundaryIndex) || lastBoundaryIndex < 0) {
    return extractRecentByUserTurns(sessionMessages, requestedTaskCount);
  }

  const previousBoundaryIndexPos = completionBoundaries.length - requestedTaskCount - 1;
  const startIndex = previousBoundaryIndexPos >= 0
    ? completionBoundaries[previousBoundaryIndexPos] + 1
    : 0;
  const endExclusive = Math.min(sessionMessages.length, lastBoundaryIndex + 1);
  if (startIndex >= endExclusive) {
    return extractRecentByUserTurns(sessionMessages, requestedTaskCount);
  }
  return sessionMessages.slice(startIndex, endExclusive);
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
  const requiredMetaById = new Map<string, { continuityAnchorTypes: string[]; forceWorkingSet?: boolean }>();

  for (const item of recentTaskMessages) {
    const key = sessionMessageIdentity(item);
    const current = requiredMetaById.get(key) ?? { continuityAnchorTypes: [] as string[] };
    if (!current.continuityAnchorTypes.includes('recent_task')) current.continuityAnchorTypes.push('recent_task');
    current.forceWorkingSet = true;
    requiredMetaById.set(key, current);
  }
  for (const item of recentUserInputs) {
    const key = sessionMessageIdentity(item);
    const current = requiredMetaById.get(key) ?? { continuityAnchorTypes: [] as string[] };
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
        ? {
          metadata: {
            ...(item.metadata ?? {}),
            ...(extraMetadata ?? {}),
            ...(requiredMetaById.get(key)?.forceWorkingSet ? { contextZone: 'working_set' } : {}),
          },
        }
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
          ...(anchorMeta.forceWorkingSet ? { contextZone: 'working_set' } : {}),
          continuityAnchor: true,
          continuityAnchorTypes: anchorMeta.continuityAnchorTypes,
        },
      };
    })
    .filter((item): item is MappedHistoryMessage => !!item);
}
