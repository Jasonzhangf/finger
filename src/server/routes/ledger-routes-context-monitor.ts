export interface ContextMonitorSlotEntry {
  slot: number;
  id: string;
  timestampIso: string;
  eventType: string;
  role: string;
  agentId: string;
  preview: string;
  finishReason?: string;
  content?: string;
  contextHistorySource?: string;
  contextBuilderBypassed?: boolean;
  contextBuilderBypassReason?: string;
  contextBuilderRebuilt?: boolean;
  modelRound?: number;
  historyItemsCount?: number;
  contextUsagePercent?: number;
  contextTokensInWindow?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ContextMonitorRound {
  id: string;
  slotStart: number;
  slotEnd: number;
  startTimeIso: string;
  endTimeIso: string;
  userPrompt: string;
  finishReason?: string;
  contextStrategy?: {
    source?: string;
    bypassed?: boolean;
    bypassReason?: string;
    rebuilt?: boolean;
    derivedFromEventType?: string;
    derivedFromSlot?: number;
  };
  modelSummary?: {
    round?: number;
    historyItemsCount?: number;
    contextUsagePercent?: number;
    contextTokensInWindow?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    derivedFromSlot?: number;
  };
  contextMessages: Array<{
    id: string;
    slot?: number;
    role: string;
    content: string;
    timestampIso: string;
    tokenCount: number;
    contextZone?: 'working_set' | 'historical_memory';
  }>;
  events: ContextMonitorSlotEntry[];
}

function extractPreview(payload: unknown, maxChars = 140): string {
  if (payload && typeof payload === 'object') {
    const asRecord = payload as Record<string, unknown>;
    if (typeof asRecord.content === 'string' && asRecord.content.trim().length > 0) {
      return asRecord.content.slice(0, maxChars);
    }
    if (typeof asRecord.summary === 'string' && asRecord.summary.trim().length > 0) {
      return asRecord.summary.slice(0, maxChars);
    }
    if (typeof asRecord.output === 'string' && asRecord.output.trim().length > 0) {
      return asRecord.output.slice(0, maxChars);
    }
    if (typeof asRecord.error === 'string' && asRecord.error.trim().length > 0) {
      return `error: ${asRecord.error.slice(0, Math.max(0, maxChars - 7))}`;
    }
  }
  try {
    return JSON.stringify(payload ?? {}).slice(0, maxChars);
  } catch {
    return '';
  }
}

export function toMonitorEntry(entry: Record<string, unknown>, slot: number): ContextMonitorSlotEntry {
  const payload = entry.payload && typeof entry.payload === 'object'
    ? entry.payload as Record<string, unknown>
    : {};
  const payloadMetadata = payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata as Record<string, unknown>
    : {};
  const extractString = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const extractBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return undefined;
  };
  const extractNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };
  const contextHistorySource = extractString(payload.contextHistorySource) ?? extractString(payloadMetadata.contextHistorySource);
  const contextBuilderBypassed = extractBoolean(payload.contextBuilderBypassed) ?? extractBoolean(payloadMetadata.contextBuilderBypassed);
  const contextBuilderBypassReason = extractString(payload.contextBuilderBypassReason) ?? extractString(payloadMetadata.contextBuilderBypassReason);
  const contextBuilderRebuilt = extractBoolean(payload.contextBuilderRebuilt) ?? extractBoolean(payloadMetadata.contextBuilderRebuilt);
  const modelRound = extractNumber(payload.round) ?? extractNumber(payload.modelRound);
  const historyItemsCount = extractNumber(payload.historyItemsCount) ?? extractNumber(payload.history_items_count);
  const contextUsagePercent = extractNumber(payload.contextUsagePercent) ?? extractNumber(payload.context_usage_percent);
  const contextTokensInWindow = extractNumber(payload.estimatedTokensInContextWindow) ?? extractNumber(payload.estimated_tokens_in_context_window);
  const inputTokens = extractNumber(payload.inputTokens) ?? extractNumber(payload.input_tokens);
  const outputTokens = extractNumber(payload.outputTokens) ?? extractNumber(payload.output_tokens);
  const totalTokens = extractNumber(payload.totalTokens) ?? extractNumber(payload.total_tokens);
  const finishReason = typeof payload.finish_reason === 'string'
    ? payload.finish_reason
    : (typeof payload.stopReason === 'string' ? payload.stopReason : undefined);
  return {
    slot,
    id: typeof entry.id === 'string' ? entry.id : `slot-${slot}`,
    timestampIso: typeof entry.timestamp_iso === 'string' ? entry.timestamp_iso : new Date().toISOString(),
    eventType: typeof entry.event_type === 'string' ? entry.event_type : '',
    role: typeof payload.role === 'string' ? payload.role : '',
    agentId: typeof entry.agent_id === 'string' ? entry.agent_id : '',
    preview: extractPreview(payload),
    ...(finishReason ? { finishReason } : {}),
    ...(typeof payload.content === 'string' ? { content: payload.content } : {}),
    ...(contextHistorySource ? { contextHistorySource } : {}),
    ...(contextBuilderBypassed !== undefined ? { contextBuilderBypassed } : {}),
    ...(contextBuilderBypassReason ? { contextBuilderBypassReason } : {}),
    ...(contextBuilderRebuilt !== undefined ? { contextBuilderRebuilt } : {}),
    ...(modelRound !== undefined ? { modelRound } : {}),
    ...(historyItemsCount !== undefined ? { historyItemsCount } : {}),
    ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
    ...(contextTokensInWindow !== undefined ? { contextTokensInWindow } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function finalizeRound(round: ContextMonitorRound | null, target: ContextMonitorRound[]): void {
  if (!round || round.events.length === 0) return;
  round.slotEnd = round.events[round.events.length - 1].slot;
  round.endTimeIso = round.events[round.events.length - 1].timestampIso;
  target.push(round);
}

export function buildContextMonitorRounds(entries: ContextMonitorSlotEntry[]): ContextMonitorRound[] {
  const rounds: ContextMonitorRound[] = [];
  let activeRound: ContextMonitorRound | null = null;
  let roundCounter = 0;

  for (const item of entries) {
    if (item.eventType === 'session_message' && item.role === 'user') {
      finalizeRound(activeRound, rounds);
      roundCounter += 1;
      activeRound = {
        id: `round-${roundCounter}-${item.slot}`,
        slotStart: item.slot,
        slotEnd: item.slot,
        startTimeIso: item.timestampIso,
        endTimeIso: item.timestampIso,
        userPrompt: item.content || '',
        contextMessages: [],
        events: [],
      };
    }

    if (!activeRound) continue;
    activeRound.events.push(item);

    if (
      !activeRound.contextStrategy
      && (
        typeof item.contextHistorySource === 'string'
        || typeof item.contextBuilderBypassed === 'boolean'
        || typeof item.contextBuilderBypassReason === 'string'
        || typeof item.contextBuilderRebuilt === 'boolean'
      )
    ) {
      activeRound.contextStrategy = {
        ...(typeof item.contextHistorySource === 'string' ? { source: item.contextHistorySource } : {}),
        ...(typeof item.contextBuilderBypassed === 'boolean' ? { bypassed: item.contextBuilderBypassed } : {}),
        ...(typeof item.contextBuilderBypassReason === 'string' ? { bypassReason: item.contextBuilderBypassReason } : {}),
        ...(typeof item.contextBuilderRebuilt === 'boolean' ? { rebuilt: item.contextBuilderRebuilt } : {}),
        derivedFromEventType: item.eventType,
        derivedFromSlot: item.slot,
      };
    }

    if (item.eventType === 'model_round' && item.finishReason && activeRound.finishReason === undefined) {
      activeRound.finishReason = item.finishReason;
    }
    if (item.eventType === 'model_round') {
      activeRound.modelSummary = {
        ...(item.modelRound !== undefined ? { round: item.modelRound } : {}),
        ...(item.historyItemsCount !== undefined ? { historyItemsCount: item.historyItemsCount } : {}),
        ...(item.contextUsagePercent !== undefined ? { contextUsagePercent: item.contextUsagePercent } : {}),
        ...(item.contextTokensInWindow !== undefined ? { contextTokensInWindow: item.contextTokensInWindow } : {}),
        ...(item.inputTokens !== undefined ? { inputTokens: item.inputTokens } : {}),
        ...(item.outputTokens !== undefined ? { outputTokens: item.outputTokens } : {}),
        ...(item.totalTokens !== undefined ? { totalTokens: item.totalTokens } : {}),
        derivedFromSlot: item.slot,
      };
    }

    if (item.eventType === 'task_complete' || item.eventType === 'turn_complete') {
      if (activeRound.finishReason === undefined) {
        activeRound.finishReason = item.finishReason || 'stop';
      }
      finalizeRound(activeRound, rounds);
      activeRound = null;
    }
  }

  finalizeRound(activeRound, rounds);
  return rounds;
}
