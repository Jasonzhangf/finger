import { promises as fs } from 'fs';
import type {
  CompactMemoryEntryFile,
  CompactMemorySearchEntry,
  ContextLedgerMemoryCompactResult,
  ContextLedgerMemoryDeleteSlotsResult,
  ContextLedgerMemoryIndexResult,
  ContextLedgerMemoryInput,
  ContextLedgerMemoryQueryResult,
  ContextLedgerMemoryResult,
  LedgerEntryFile,
} from './context-ledger-memory-types.js';
import type { TaskBlock, TaskMessage } from './context-builder-types.js';
import {
  appendLedgerEvent,
  buildPreview,
  containsPromptLikeBlock,
  DEFAULT_FOCUS_MAX_CHARS,
  DEFAULT_QUERY_LIMIT,
  fuzzyScore,
  keepTailChars,
  normalizePositiveInt,
  normalizeRootDir,
  normalizeStringArray,
  normalizeText,
  paginate,
  parseInput,
  parseRuntimeContext,
  pickString,
  readJsonLines,
  resolveBaseDir,
  resolveCompactMemoryIndexPath,
  resolveCompactMemoryPath,
  resolveFullMemoryPath,
  resolveLedgerPath,
  safeReadText,
  toTimestampMs,
  valueAsString,
  writeJsonFile,
} from './context-ledger-memory-helpers.js';
import { runTaskEmbeddingRecall } from './context-builder-embedding-recall.js';

export type {
  CompactMemoryEntryFile,
  CompactMemorySearchEntry,
  ContextLedgerMemoryAction,
  ContextLedgerMemoryInput,
  ContextLedgerMemoryInsertResult,
  ContextLedgerMemoryQueryResult,
  ContextLedgerMemoryResult,
  ContextLedgerMemoryRuntimeContext,
  LedgerEntryFile,
} from './context-ledger-memory-types.js';

export async function executeContextLedgerMemory(rawInput: unknown): Promise<ContextLedgerMemoryResult> {
  const input = parseInput(rawInput);
  const runtime = parseRuntimeContext(input._runtime_context);

  const sessionId = pickString(input.session_id, runtime.session_id);
  const currentAgentId = pickString(runtime.agent_id, input.agent_id);
  const mode = pickString(input.mode, runtime.mode, 'main') ?? 'main';
  const rootDir = normalizeRootDir(runtime.root_dir);

  if (!sessionId) throw new Error('context_ledger.memory requires session_id');
  if (!currentAgentId) {
    throw new Error('context_ledger.memory requires agent_id (or _runtime_context.agent_id)');
  }

  if (input.action === 'insert') {
    return executeInsertAction(input, {
      rootDir,
      sessionId,
      currentAgentId,
      mode,
      focusMaxChars:
        normalizePositiveInt(input.focus_max_chars)
        ?? normalizePositiveInt(runtime.focus_max_chars)
        ?? DEFAULT_FOCUS_MAX_CHARS,
    });
  }

  if (input.action === 'index') {
    return executeIndexAction({
      rootDir,
      sessionId,
      currentAgentId,
      mode,
      fullReindex: input.full_reindex === true,
    });
  }

  if (input.action === 'compact') {
    return executeCompactAction(input, {
      rootDir,
      sessionId,
      currentAgentId,
      mode,
    });
  }

  if (input.action === 'delete_slots') {
    return executeDeleteSlotsAction(input, {
      rootDir,
      sessionId,
      currentAgentId,
      targetAgentId: pickString(input.agent_id, currentAgentId) ?? currentAgentId,
      mode,
      canReadAll: runtime.can_read_all === true,
      readableAgents: runtime.readable_agents ?? [],
    });
  }

  return executeQueryAction(input, {
    rootDir,
    sessionId,
    currentAgentId,
    targetAgentId: pickString(input.agent_id, currentAgentId) ?? currentAgentId,
    mode,
    canReadAll: runtime.can_read_all === true,
    readableAgents: runtime.readable_agents ?? [],
  });
}

async function executeQueryAction(
  input: ContextLedgerMemoryInput,
  context: {
    rootDir: string;
    sessionId: string;
    currentAgentId: string;
    targetAgentId: string;
    mode: string;
    canReadAll: boolean;
    readableAgents: string[];
  },
): Promise<ContextLedgerMemoryQueryResult> {
  ensureReadableAgent(
    context.currentAgentId,
    context.targetAgentId,
    context.canReadAll,
    context.readableAgents,
  );

  const query = {
    sinceMs: normalizePositiveInt(input.since_ms),
    untilMs: normalizePositiveInt(input.until_ms),
    contains: normalizeText(input.contains),
    fuzzy: input.fuzzy === true,
    eventTypes: normalizeStringArray(input.event_types),
    limit: normalizePositiveInt(input.limit) ?? DEFAULT_QUERY_LIMIT,
    slotStart: normalizePositiveInt(input.slot_start),
    slotEnd: normalizePositiveInt(input.slot_end),
  };

  const ledgerPath = resolveLedgerPath(context.rootDir, context.sessionId, context.targetAgentId, context.mode);
  const compactPath = resolveCompactMemoryPath(context.rootDir, context.sessionId, context.targetAgentId, context.mode);
  const compactIndexPath = resolveCompactMemoryIndexPath(
    context.rootDir,
    context.sessionId,
    context.targetAgentId,
    context.mode,
  );

  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const ledgerTaskBlocks = await buildLedgerTaskBlocks(allEntries, {
    rootDir: context.rootDir,
    sessionId: context.sessionId,
    agentId: context.targetAgentId,
    mode: context.mode,
    query: query.contains,
    fuzzy: query.fuzzy,
    limit: query.limit,
    runtimeContext: input._runtime_context,
  });
  const preciseHits = filterLedgerEntries(allEntries, { ...query, fuzzy: false });
  const directHits = filterLedgerEntries(allEntries, query);
  const hasPreciseHits = query.contains ? preciseHits.length > 0 : directHits.length > 0;

  const shouldUseCompactFirst = Boolean(query.fuzzy && query.contains && !hasPreciseHits);
  const compactEntries = await readCompactSearchEntries(compactPath, compactIndexPath);
  const compactHits = shouldUseCompactFirst
    ? filterCompactEntries(compactEntries, query.contains, true, query.limit)
    : [];

  if (shouldUseCompactFirst && compactHits.length > 0 && input.detail !== true) {
    return {
      ok: true,
      action: input.action === 'search' ? 'search' : 'query',
      strategy: 'compact_first',
      source: ledgerPath,
      entries: [],
      slots: [],
      timeline: [],
      slot_start: 0,
      slot_end: 0,
      total: 0,
      truncated: false,
      compact_hits: compactHits,
      compact_source: compactEntries.length > 0 ? compactIndexPath : compactPath,
      compact_total: compactHits.length,
      compact_truncated: false,
      task_blocks: ledgerTaskBlocks,
      context_bridge: buildContextBridge(allEntries.length, ledgerTaskBlocks, input._runtime_context),
      next_query_hint: {
        action: 'query',
        detail: true,
        slot_start: compactHits[0].source_slot_start,
        slot_end: compactHits[0].source_slot_end,
        since_ms: toTimestampMs(compactHits[0].source_time_start),
        until_ms: toTimestampMs(compactHits[0].source_time_end),
        contains: query.contains,
        fuzzy: false,
      },
      note: 'Search matched compact memory first. Use next_query_hint with slot_start/slot_end to fetch detailed ledger records.',
    };
  }

  const deepRange = shouldUseCompactFirst && compactHits.length > 0 && input.detail === true
    ? {
        sinceMs: query.sinceMs ?? toTimestampMs(compactHits[0].source_time_start),
        untilMs: query.untilMs ?? toTimestampMs(compactHits[0].source_time_end),
      }
    : { sinceMs: query.sinceMs, untilMs: query.untilMs };

  const detailHits = filterLedgerEntries(allEntries, {
    ...query,
    contains: shouldUseCompactFirst ? undefined : query.contains,
    fuzzy: shouldUseCompactFirst ? false : query.fuzzy,
    sinceMs: deepRange.sinceMs,
    untilMs: deepRange.untilMs,
  });
  const paged = paginateBySlot(detailHits, query.limit, query.slotStart, query.slotEnd);
  const slots = paged.items.map(({ slot, entry }) => ({
    slot,
    id: entry.id,
    timestamp_ms: entry.timestamp_ms,
    timestamp_iso: entry.timestamp_iso,
    event_type: entry.event_type,
    agent_id: entry.agent_id,
    mode: entry.mode,
    preview: buildPreview(JSON.stringify(entry.payload), 180),
  }));
  const shouldReturnEntries = input.action === 'query' && (
    input.detail === true
    || query.slotStart !== undefined
    || query.slotEnd !== undefined
  );

  return {
    ok: true,
    action: input.action === 'search' ? 'search' : 'query',
    strategy: shouldUseCompactFirst && compactHits.length > 0 ? 'compact_then_detail' : 'direct_ledger',
    source: ledgerPath,
    entries: shouldReturnEntries ? paged.items.map(({ entry }) => entry) : [],
    slots,
    timeline: slots,
    slot_start: paged.slotStart,
    slot_end: paged.slotEnd,
    total: paged.total,
    truncated: paged.truncated,
    compact_hits: compactHits,
    compact_source: compactEntries.length > 0 ? compactIndexPath : compactPath,
    compact_total: compactHits.length,
    compact_truncated: false,
    task_blocks: ledgerTaskBlocks,
    context_bridge: buildContextBridge(allEntries.length, ledgerTaskBlocks, input._runtime_context),
    next_query_hint: slots.length > 0
      ? {
          action: 'query',
          slot_start: paged.slotStart,
          slot_end: paged.slotEnd,
          since_ms: slots[0]?.timestamp_ms,
          until_ms: slots[slots.length - 1]?.timestamp_ms,
          contains: query.contains,
          fuzzy: false,
          detail: true,
        }
      : undefined,
    note: input.action === 'search'
      ? 'Search returned matching slot summaries only. Use query with slot_start/slot_end for detailed ledger entries.'
      : shouldReturnEntries
        ? 'Query returned detailed ledger entries for the requested slot range.'
        : 'Query returned slot summaries only. Add slot_start/slot_end or detail=true to fetch detailed ledger entries.',
  };
}

function paginateBySlot<T>(
  items: T[],
  requestedLimit: number,
  slotStart?: number,
  slotEnd?: number,
): {
  items: Array<{ slot: number; entry: T }>;
  total: number;
  truncated: boolean;
  slotStart: number;
  slotEnd: number;
} {
  const paged = paginate(items, requestedLimit);
  const total = items.length;
  if (total === 0) {
    return {
      items: [],
      total,
      truncated: false,
      slotStart: 0,
      slotEnd: 0,
    };
  }

  let start = slotStart ?? Math.max(1, total - paged.items.length + 1);
  start = Math.min(Math.max(1, start), total);

  let end = slotEnd ?? Math.min(total, start + requestedLimit - 1);
  end = Math.min(Math.max(start, end), total);
  if (end - start + 1 > requestedLimit) {
    end = Math.min(total, start + requestedLimit - 1);
  }

  if (slotStart === undefined && slotEnd === undefined) {
    start = Math.max(1, total - requestedLimit + 1);
    end = total;
  }

  const sliced = items.slice(start - 1, end);
  return {
    items: sliced.map((entry, index) => ({ slot: start + index, entry })),
    total,
    truncated: start > 1 || end < total,
    slotStart: start,
    slotEnd: sliced.length > 0 ? start + sliced.length - 1 : 0,
  };
}

async function executeInsertAction(
  input: ContextLedgerMemoryInput,
  context: {
    rootDir: string;
    sessionId: string;
    currentAgentId: string;
    mode: string;
    focusMaxChars: number;
  },
): Promise<ContextLedgerMemoryResult> {
  const baseDir = resolveBaseDir(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const ledgerPath = resolveLedgerPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const focusPath = `${baseDir}/focus-slot.txt`;

  await fs.mkdir(baseDir, { recursive: true });

  const explicitText = normalizeText(input.text);
  const synthesizedText = explicitText ?? await synthesizeInsertTextFromRange(ledgerPath, input);
  if (!synthesizedText) {
    throw new Error('context_ledger.memory insert requires text or a valid [since_ms, until_ms] range');
  }

  const append = input.append === true;
  const existing = append ? await safeReadText(focusPath) : '';
  const merged = append && existing.trim().length > 0 ? `${existing.trim()}\n${synthesizedText}` : synthesizedText;

  const limited = keepTailChars(merged, Math.max(1, context.focusMaxChars));
  const truncated = limited.chars.count < Array.from(merged).length;

  await fs.writeFile(focusPath, limited.text, 'utf-8');
  await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.currentAgentId,
    mode: context.mode,
    event_type: 'focus_insert',
    payload: {
      append,
      chars: limited.chars.count,
      truncated,
      source: 'context_ledger.memory',
      text_preview: buildPreview(synthesizedText, 160),
    },
  });

  return {
    ok: true,
    action: 'insert',
    chars: limited.chars.count,
    truncated,
    focus_path: focusPath,
  };
}

async function executeIndexAction(context: {
  rootDir: string;
  sessionId: string;
  currentAgentId: string;
  mode: string;
  fullReindex: boolean;
}): Promise<ContextLedgerMemoryIndexResult> {
  const compactPath = resolveCompactMemoryPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const compactIndexPath = resolveCompactMemoryIndexPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const entries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
  const normalizedEntries = entries
    .map((entry) => ({
      id: entry.id,
      timestamp_ms: entry.timestamp_ms,
      timestamp_iso: entry.timestamp_iso,
      summary: valueAsString(entry.payload.summary) ?? JSON.stringify(entry.payload),
      source_time_start: valueAsString(entry.payload.source_time_start),
      source_time_end: valueAsString(entry.payload.source_time_end),
      source_slot_start: normalizePositiveInt(entry.payload.source_slot_start),
      source_slot_end: normalizePositiveInt(entry.payload.source_slot_end),
      trigger: (valueAsString(entry.payload.trigger) === "auto" ? "auto" : (valueAsString(entry.payload.trigger) === "manual" ? "manual" : undefined)) as "auto" | "manual" | undefined,
      linked_event_ids: Array.isArray(entry.payload.linked_event_ids)
        ? entry.payload.linked_event_ids.filter((item): item is string => typeof item === 'string')
        : [],
      linked_message_ids: Array.isArray(entry.payload.linked_message_ids)
        ? entry.payload.linked_message_ids.filter((item): item is string => typeof item === 'string')
        : [],
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  await writeJsonFile(compactIndexPath, {
    version: 1,
    generated_at: new Date().toISOString(),
    full_reindex: context.fullReindex,
    entries: normalizedEntries,
  });

  return {
    ok: true,
    action: 'index',
    compact_source: compactPath,
    compact_index_path: compactIndexPath,
    entries_indexed: normalizedEntries.length,
    full_reindex: context.fullReindex,
  };
}

async function executeCompactAction(
  input: ContextLedgerMemoryInput,
  context: {
    rootDir: string;
    sessionId: string;
    currentAgentId: string;
    mode: string;
  },
): Promise<ContextLedgerMemoryCompactResult> {
  const baseDir = resolveBaseDir(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const ledgerPath = resolveLedgerPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const compactPath = resolveCompactMemoryPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);
  const fullMemoryPath = resolveFullMemoryPath(context.rootDir, context.sessionId, context.currentAgentId, context.mode);

  await fs.mkdir(baseDir, { recursive: true });

  const fullLedgerEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const candidateEntries = fullLedgerEntries.filter((entry) => entry.event_type !== 'context_compact');
  const linkedEventIds = input.source_event_ids && input.source_event_ids.length > 0
    ? input.source_event_ids
    : candidateEntries.map((entry) => entry.id);

  const linkedEntries = candidateEntries.filter((entry) => linkedEventIds.includes(entry.id));
  const sourceTimeStart = input.source_time_start
    ?? (linkedEntries.length > 0 ? linkedEntries[0].timestamp_iso : undefined);
  const sourceTimeEnd = input.source_time_end
    ?? (linkedEntries.length > 0 ? linkedEntries[linkedEntries.length - 1].timestamp_iso : undefined);
  const sourceSlotStart = input.source_slot_start ?? (linkedEntries.length > 0 ? 1 : undefined);
  const sourceSlotEnd = input.source_slot_end ?? (linkedEntries.length > 0 ? linkedEntries.length : undefined);
  const trigger = input.trigger === 'auto' ? 'auto' : 'manual';
  const summary = normalizeText(input.summary)
    ?? buildCompactSummaryFromEntries(linkedEntries);

  const compactionId = `cpt-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const compactEntry: CompactMemoryEntryFile = {
    id: compactionId,
    timestamp_ms: Date.now(),
    timestamp_iso: new Date().toISOString(),
    session_id: context.sessionId,
    agent_id: context.currentAgentId,
    mode: context.mode,
    payload: {
      summary,
      trigger,
      source_time_start: sourceTimeStart,
      source_time_end: sourceTimeEnd,
      source_slot_start: sourceSlotStart,
      source_slot_end: sourceSlotEnd,
      linked_event_ids: linkedEventIds,
      linked_message_ids: input.source_message_ids ?? [],
      replacement_history: input.replacement_history ?? [],
    },
  };

  const fullMemoryEntries = linkedEntries.map((entry, index) => ({
    id: entry.id,
    timestamp_ms: entry.timestamp_ms,
    timestamp_iso: entry.timestamp_iso,
    type: 'session_event',
    event_type: entry.event_type,
    slot: index + 1,
    payload: entry.payload,
  }));

  if (fullMemoryEntries.length > 0) {
    await fs.writeFile(fullMemoryPath, `${fullMemoryEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf-8');
  }
  await fs.appendFile(compactPath, `${JSON.stringify(compactEntry)}\n`, 'utf-8');

  await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.currentAgentId,
    mode: context.mode,
    event_type: 'context_compact',
    payload: {
      compaction_id: compactionId,
      summary,
      trigger,
      source_time_start: sourceTimeStart,
      source_time_end: sourceTimeEnd,
      source_slot_start: sourceSlotStart,
      source_slot_end: sourceSlotEnd,
      linked_event_ids: linkedEventIds,
      linked_message_ids: input.source_message_ids ?? [],
    },
  });

  const indexResult = await executeIndexAction({
    rootDir: context.rootDir,
    sessionId: context.sessionId,
    currentAgentId: context.currentAgentId,
    mode: context.mode,
    fullReindex: false,
  });

  return {
    ok: true,
    action: 'compact',
    compaction_id: compactionId,
    summary,
    trigger,
    compact_path: compactPath,
    compact_index_path: indexResult.compact_index_path,
    source_time_start: sourceTimeStart,
    source_time_end: sourceTimeEnd,
    source_slot_start: sourceSlotStart,
    source_slot_end: sourceSlotEnd,
    linked_event_ids: linkedEventIds,
    linked_message_ids: input.source_message_ids ?? [],
    indexed: true,
  };
}

async function executeDeleteSlotsAction(
  input: ContextLedgerMemoryInput,
  context: {
    rootDir: string;
    sessionId: string;
    currentAgentId: string;
    targetAgentId: string;
    mode: string;
    canReadAll: boolean;
    readableAgents: string[];
  },
): Promise<ContextLedgerMemoryDeleteSlotsResult> {
  ensureReadableAgent(
    context.currentAgentId,
    context.targetAgentId,
    context.canReadAll,
    context.readableAgents,
  );

  const slotIds = Array.from(new Set((input.slot_ids ?? [])
    .map((slot) => normalizePositiveInt(slot))
    .filter((slot): slot is number => typeof slot === 'number')
  )).sort((a, b) => a - b);

  if (slotIds.length === 0) {
    throw new Error('delete_slots requires slot_ids (array of 1-based slot numbers)');
  }

  const ledgerPath = resolveLedgerPath(context.rootDir, context.sessionId, context.targetAgentId, context.mode);
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);

  const selected = slotIds
    .filter((slot) => slot >= 1 && slot <= allEntries.length)
    .map((slot) => ({ slot, entry: allEntries[slot - 1] }))
    .filter((item) => item.entry.event_type !== 'context_compact');

  const selectedSlots = selected.map(({ slot, entry }) => ({
    slot,
    id: entry.id,
    timestamp_ms: entry.timestamp_ms,
    timestamp_iso: entry.timestamp_iso,
    event_type: entry.event_type,
    preview: buildPreview(JSON.stringify(entry.payload), 220),
  }));

  if (selectedSlots.length === 0) {
    return {
      ok: true,
      action: 'delete_slots',
      source: ledgerPath,
      target_agent_id: context.targetAgentId,
      selected_slots: [],
      selected_total: 0,
      deleted_count: 0,
      preview_only: true,
      requires_confirmation: true,
      intent_id: normalizeText(input.intent_id) ?? undefined,
      note: 'No deletable slots matched. context_compact entries are protected and cannot be deleted by this action.',
    };
  }

  const resolvedIntentId = normalizeText(input.intent_id)
    ?? `DEL-${context.targetAgentId}-${selectedSlots.map((item) => item.slot).join('-')}`;
  const confirmationPhrase = `CONFIRM_DELETE_SLOTS:${resolvedIntentId}:${selectedSlots.map((item) => item.slot).join(',')}`;
  const confirmToken = normalizeText(input.user_confirmation);
  const authorized = input.user_authorized === true;
  const previewOnly = input.preview_only === true || input.confirm !== true;
  const confirmed = input.confirm === true && confirmToken === confirmationPhrase && authorized;

  if (previewOnly || !confirmed) {
    return {
      ok: true,
      action: 'delete_slots',
      source: ledgerPath,
      target_agent_id: context.targetAgentId,
      selected_slots: selectedSlots,
      selected_total: selectedSlots.length,
      deleted_count: 0,
      preview_only: true,
      requires_confirmation: true,
      reason: normalizeText(input.reason),
      intent_id: resolvedIntentId,
      confirmation_phrase: confirmationPhrase,
      note: [
        'Deletion preview only. No ledger data has been deleted.',
        'Before delete, show this summary to user and ask explicit permission.',
        'To execute deletion, call again with confirm=true, user_authorized=true, and exact user_confirmation=confirmation_phrase.',
      ].join(' '),
    };
  }

  const deleteIndexSet = new Set(selected.map(({ slot }) => slot - 1));
  const remaining = allEntries.filter((_, index) => !deleteIndexSet.has(index));
  const content = remaining.length > 0
    ? `${remaining.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    : '';
  await fs.writeFile(ledgerPath, content, 'utf-8');

  await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.currentAgentId,
    mode: context.mode,
    event_type: 'ledger_slots_deleted',
    payload: {
      source: 'context_ledger.memory',
      target_agent_id: context.targetAgentId,
      deleted_slots: selectedSlots.map((item) => item.slot),
      deleted_event_ids: selectedSlots.map((item) => item.id),
      deleted_count: selectedSlots.length,
      reason: normalizeText(input.reason),
      user_confirmation: confirmToken,
      intent_id: resolvedIntentId,
      confirmation_phrase: confirmationPhrase,
    },
  });

  return {
    ok: true,
    action: 'delete_slots',
    source: ledgerPath,
    target_agent_id: context.targetAgentId,
    selected_slots: selectedSlots,
    selected_total: selectedSlots.length,
    deleted_count: selectedSlots.length,
    preview_only: false,
    requires_confirmation: false,
    reason: normalizeText(input.reason),
    intent_id: resolvedIntentId,
    confirmation_phrase: confirmationPhrase,
    note: 'Ledger slots deleted successfully after explicit user authorization.',
  };
}

function buildCompactSummaryFromEntries(entries: LedgerEntryFile[]): string {
  if (entries.length === 0) return '(no summary available)';
  const previews = entries
    .slice(-6)
    .map((entry) => `[${entry.event_type}] ${buildPreview(JSON.stringify(entry.payload), 120)}`);
  return previews.join('\n');
}

type LedgerTaskBlockSearchResult = ContextLedgerMemoryQueryResult['task_blocks'][number];

interface LedgerTaskBlockInternal {
  id: string;
  startSlot: number;
  endSlot: number;
  startTime: number;
  endTime: number;
  startTimeIso: string;
  endTimeIso: string;
  entries: LedgerEntryFile[];
  tags?: string[];
  topic?: string;
  preview: string;
  searchText: string;
  taskBlock: TaskBlock;
}

type TaskBlockMatchReason = LedgerTaskBlockSearchResult['match_reason'];

async function buildLedgerTaskBlocks(
  entries: LedgerEntryFile[],
  options: {
    rootDir: string;
    sessionId: string;
    agentId: string;
    mode: string;
    query?: string;
    fuzzy: boolean;
    limit: number;
    runtimeContext?: ContextLedgerMemoryInput['_runtime_context'];
  },
): Promise<ContextLedgerMemoryQueryResult['task_blocks']> {
  const blocks = groupLedgerEntriesByTaskBoundary(entries);
  if (blocks.length === 0) return [];

  const normalizedQuery = normalizeText(options.query)?.toLowerCase();
  const keywordScored = blocks.map((block) => {
    if (!normalizedQuery) {
      return { block, score: 0, matchReason: 'recency' as const };
    }

    const lowered = block.searchText.toLowerCase();
    const direct = lowered.includes(normalizedQuery) ? 1 : 0;
    const fuzzy = options.fuzzy ? fuzzyScore(lowered, normalizedQuery) : 0;
    const score = direct > 0 ? 2 + fuzzy : fuzzy;
    return {
      block,
      score,
      matchReason: direct > 0
        ? (fuzzy > 0 ? 'keyword+embedding' as const : 'keyword' as const)
        : (fuzzy > 0 ? 'embedding' as const : 'recency' as const),
    };
  });

  let embeddingRank = new Map<string, number>();
  if (normalizedQuery) {
    try {
      const embeddingRecall = await runTaskEmbeddingRecall({
        rootDir: options.rootDir,
        sessionId: options.sessionId,
        agentId: options.agentId,
        mode: options.mode,
        blocks: blocks.map((block) => block.taskBlock),
        currentPrompt: normalizedQuery,
        topK: Math.min(Math.max(1, options.limit), blocks.length),
      });
      if (embeddingRecall.executed) {
        embeddingRank = new Map(embeddingRecall.rankedTaskIds.map((id, index) => [id, index]));
      }
    } catch {
      embeddingRank = new Map();
    }
  }

  const ranked = keywordScored
    .map(({ block, score, matchReason }) => {
      const embeddingIndex = embeddingRank.get(block.id);
      const embeddingBoost = embeddingIndex === undefined
        ? 0
        : Math.max(0, (blocks.length - embeddingIndex) / Math.max(1, blocks.length));
      const combinedScore = score + embeddingBoost;
      let finalReason: TaskBlockMatchReason = 'recency';
      if (score > 0 && embeddingBoost > 0) {
        finalReason = 'keyword+embedding';
      } else if (score > 0) {
        finalReason = matchReason === 'embedding' ? 'keyword' : matchReason;
      } else if (embeddingBoost > 0) {
        finalReason = 'embedding';
      }
      return {
        block,
        score: combinedScore,
        matchReason: finalReason,
        embeddingIndex: embeddingIndex ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .filter((item) => {
      if (!normalizedQuery) return true;
      if (item.score > 0) return true;
      return item.embeddingIndex !== Number.MAX_SAFE_INTEGER && item.embeddingIndex < options.limit;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.embeddingIndex !== b.embeddingIndex) return a.embeddingIndex - b.embeddingIndex;
      return b.block.startTime - a.block.startTime;
    })
    .slice(0, Math.max(1, options.limit));

  return ranked.map(({ block, score, matchReason }) => ({
    id: block.id,
    start_slot: block.startSlot,
    end_slot: block.endSlot,
    start_time_ms: block.startTime,
    end_time_ms: block.endTime,
    start_time_iso: block.startTimeIso,
    end_time_iso: block.endTimeIso,
    preview: block.preview,
    ...(block.tags && block.tags.length > 0 ? { tags: block.tags } : {}),
    ...(block.topic ? { topic: block.topic } : {}),
    ...(Number.isFinite(score) ? { score: Number(score.toFixed(4)) } : {}),
    match_reason: matchReason,
    visibility: resolveTaskBlockVisibility(block.id, options.runtimeContext),
    detail_query_hint: {
      action: 'query',
      detail: true,
      slot_start: block.startSlot,
      slot_end: block.endSlot,
    },
  }));
}

function groupLedgerEntriesByTaskBoundary(entries: LedgerEntryFile[]): LedgerTaskBlockInternal[] {
  const sanitized = entries
    .filter((entry) => {
      const searchable = `${entry.event_type}\n${JSON.stringify(entry.payload)}`;
      return !containsPromptLikeBlock(searchable);
    })
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  if (sanitized.length === 0) return [];

  const blocks: LedgerTaskBlockInternal[] = [];
  let currentEntries: LedgerEntryFile[] = [];
  let currentStartSlot = 1;

  const flush = () => {
    if (currentEntries.length === 0) return;
    blocks.push(finalizeLedgerTaskBlock(currentEntries, currentStartSlot, currentStartSlot + currentEntries.length - 1));
  };

  for (let index = 0; index < sanitized.length; index += 1) {
    const entry = sanitized[index];
    const payload = isRecord(entry.payload) ? entry.payload : {};
    const role = valueAsString(payload.role) ?? 'system';
    if (role === 'user' && currentEntries.length > 0) {
      flush();
      currentEntries = [entry];
      currentStartSlot = index + 1;
      continue;
    }
    if (currentEntries.length === 0) {
      currentStartSlot = index + 1;
    }
    currentEntries.push(entry);
  }
  flush();
  return blocks;
}

function finalizeLedgerTaskBlock(entries: LedgerEntryFile[], startSlot: number, endSlot: number): LedgerTaskBlockInternal {
  const taskMessages: TaskMessage[] = entries.map((entry) => {
    const payload = isRecord(entry.payload) ? entry.payload : {};
    const content = valueAsString(payload.content) ?? JSON.stringify(payload);
    return {
      id: entry.id,
      role: ((valueAsString(payload.role) ?? 'system') as TaskMessage['role']),
      content,
      timestamp: entry.timestamp_ms,
      timestampIso: entry.timestamp_iso,
      tokenCount: Math.max(1, Math.ceil(content.length / 4)),
      metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
    };
  });

  let tags: string[] | undefined;
  let topic: string | undefined;
  for (let index = taskMessages.length - 1; index >= 0; index -= 1) {
    const metadata = taskMessages[index].metadata;
    if (!metadata) continue;
    if (Array.isArray(metadata.tags)) {
      const normalized = metadata.tags
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim());
      if (normalized.length > 0) {
        tags = tags ? Array.from(new Set([...tags, ...normalized])) : normalized;
      }
    }
    const metaTopic = valueAsString(metadata.topic);
    if (!topic && metaTopic) topic = metaTopic;
  }

  const firstUser = taskMessages.find((message) => message.role === 'user')?.content;
  const lastAssistant = [...taskMessages].reverse().find((message) => message.role === 'assistant')?.content;
  const preview = firstUser
    ? buildPreview(firstUser, 200)
    : lastAssistant
      ? buildPreview(lastAssistant, 200)
      : buildPreview(JSON.stringify(entries[entries.length - 1]?.payload ?? {}), 200);
  const searchText = [
    tags && tags.length > 0 ? `tags: ${tags.join(', ')}` : '',
    topic ? `topic: ${topic}` : '',
    ...entries.map((entry) => `${entry.event_type} ${JSON.stringify(entry.payload)}`),
  ]
    .filter((item) => item.length > 0)
    .join('\n');

  return {
    id: `task-${entries[0]?.timestamp_ms ?? Date.now()}`,
    startSlot,
    endSlot,
    startTime: entries[0]?.timestamp_ms ?? Date.now(),
    endTime: entries[entries.length - 1]?.timestamp_ms ?? Date.now(),
    startTimeIso: entries[0]?.timestamp_iso ?? new Date().toISOString(),
    endTimeIso: entries[entries.length - 1]?.timestamp_iso ?? new Date().toISOString(),
    entries,
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(topic ? { topic } : {}),
    preview,
    searchText,
    taskBlock: {
      id: `task-${entries[0]?.timestamp_ms ?? Date.now()}`,
      startTime: entries[0]?.timestamp_ms ?? Date.now(),
      endTime: entries[entries.length - 1]?.timestamp_ms ?? Date.now(),
      startTimeIso: entries[0]?.timestamp_iso ?? new Date().toISOString(),
      endTimeIso: entries[entries.length - 1]?.timestamp_iso ?? new Date().toISOString(),
      messages: taskMessages,
      tokenCount: taskMessages.reduce((sum, message) => sum + message.tokenCount, 0),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(topic ? { topic } : {}),
    },
  };
}

function resolveTaskBlockVisibility(
  blockId: string,
  runtimeContext?: ContextLedgerMemoryInput['_runtime_context'],
): LedgerTaskBlockSearchResult['visibility'] {
  const builder = runtimeContext?.context_builder;
  if (!builder) return 'unknown';
  if (builder.working_set_block_ids?.includes(blockId)) return 'working_set';
  if (builder.historical_block_ids?.includes(blockId)) return 'historical_memory';
  return 'omitted_history';
}

function buildContextBridge(
  totalSlots: number,
  taskBlocks: ContextLedgerMemoryQueryResult['task_blocks'],
  runtimeContext?: ContextLedgerMemoryInput['_runtime_context'],
): ContextLedgerMemoryQueryResult['context_bridge'] {
  const builder = runtimeContext?.context_builder;
  return {
    searched_full_ledger: true,
    total_slots: totalSlots,
    note: taskBlocks.length > 0
      ? 'Search inspected the full ledger and returned task-block candidates that can be drilled into with detail_query_hint. These candidates may sit outside the currently injected prompt history budget.'
      : 'Search inspected the full ledger but did not find task-block candidates for this query.',
    ...(builder?.working_set_block_ids && builder.working_set_block_ids.length > 0
      ? { working_set_block_ids: builder.working_set_block_ids }
      : {}),
    ...(builder?.historical_block_ids && builder.historical_block_ids.length > 0
      ? { historical_block_ids: builder.historical_block_ids }
      : {}),
  };
}

function filterLedgerEntries(
  entries: LedgerEntryFile[],
  options: { sinceMs?: number; untilMs?: number; contains?: string; fuzzy: boolean; eventTypes: string[] },
): LedgerEntryFile[] {
  const eventTypeSet = new Set(options.eventTypes.map((item) => item.toLowerCase()));
  const needle = options.contains?.toLowerCase();

  return entries
    .filter((entry) => {
      if (options.sinceMs !== undefined && entry.timestamp_ms < options.sinceMs) return false;
      if (options.untilMs !== undefined && entry.timestamp_ms > options.untilMs) return false;
      if (eventTypeSet.size > 0 && !eventTypeSet.has(entry.event_type.toLowerCase())) return false;

      const searchable = `${entry.event_type}\n${JSON.stringify(entry.payload)}`;
      if (containsPromptLikeBlock(searchable)) return false;

      if (!needle) return true;
      const lowered = searchable.toLowerCase();
      if (lowered.includes(needle)) return true;
      return options.fuzzy ? fuzzyScore(lowered, needle) >= 0.18 : false;
    })
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
}

function filterCompactEntries(
  entries: CompactMemorySearchEntry[],
  contains: string | undefined,
  fuzzy: boolean,
  limit: number,
): ContextLedgerMemoryQueryResult['compact_hits'] {
  const needle = contains?.toLowerCase();
  const filtered = entries
    .filter((entry) => {
      if (containsPromptLikeBlock(entry.summary)) return false;
      if (!needle) return true;
      const lowered = entry.summary.toLowerCase();
      if (lowered.includes(needle)) return true;
      return fuzzy ? fuzzyScore(lowered, needle) >= 0.18 : false;
    })
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  return paginate(filtered, limit).items.map((entry) => ({
    id: entry.id,
    timestamp_ms: entry.timestamp_ms,
    timestamp_iso: entry.timestamp_iso,
    summary: entry.summary,
    source_time_start: entry.source_time_start,
    source_time_end: entry.source_time_end,
    source_slot_start: entry.source_slot_start,
    source_slot_end: entry.source_slot_end,
    trigger: entry.trigger,
    preview: buildPreview(entry.summary, 180),
  }));
}

async function readCompactSearchEntries(
  compactPath: string,
  compactIndexPath: string,
): Promise<CompactMemorySearchEntry[]> {
  const indexed = await readCompactSearchEntriesFromIndex(compactIndexPath);
  if (indexed.length > 0) return indexed;

  const rawEntries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
  return rawEntries
    .map((entry) => ({
      id: entry.id,
      timestamp_ms: entry.timestamp_ms,
      timestamp_iso: entry.timestamp_iso,
      summary: valueAsString(entry.payload.summary) ?? JSON.stringify(entry.payload),
      source_time_start: valueAsString(entry.payload.source_time_start),
      source_time_end: valueAsString(entry.payload.source_time_end),
      source_slot_start: normalizePositiveInt(entry.payload.source_slot_start),
      source_slot_end: normalizePositiveInt(entry.payload.source_slot_end),
      trigger: (valueAsString(entry.payload.trigger) === "auto" ? "auto" : (valueAsString(entry.payload.trigger) === "manual" ? "manual" : undefined)) as "auto" | "manual" | undefined,
      linked_event_ids: Array.isArray(entry.payload.linked_event_ids)
        ? entry.payload.linked_event_ids.filter((item): item is string => typeof item === 'string')
        : [],
      linked_message_ids: Array.isArray(entry.payload.linked_message_ids)
        ? entry.payload.linked_message_ids.filter((item): item is string => typeof item === 'string')
        : [],
    }))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
}

async function readCompactSearchEntriesFromIndex(indexPath: string): Promise<CompactMemorySearchEntry[]> {
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return [];
    }

    return ((parsed as { entries: unknown[] }).entries)
      .flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const raw = item as Record<string, unknown>;
        const timestamp_ms = normalizePositiveInt(raw.timestamp_ms);
        const summary = valueAsString(raw.summary);
        if (!timestamp_ms || !summary) return [];
        return [{
          id: valueAsString(raw.id) ?? 'unknown',
          timestamp_ms,
          timestamp_iso: valueAsString(raw.timestamp_iso) ?? '',
          summary,
          source_time_start: valueAsString(raw.source_time_start),
          source_time_end: valueAsString(raw.source_time_end),
          source_slot_start: normalizePositiveInt(raw.source_slot_start),
          source_slot_end: normalizePositiveInt(raw.source_slot_end),
          trigger: (valueAsString(raw.trigger) === 'auto' ? 'auto' : 'manual') as 'auto' | 'manual' | undefined,
          linked_event_ids: Array.isArray(raw.linked_event_ids)
            ? raw.linked_event_ids.filter((item): item is string => typeof item === 'string')
            : [],
          linked_message_ids: Array.isArray(raw.linked_message_ids)
            ? raw.linked_message_ids.filter((item): item is string => typeof item === 'string')
            : [],
        }];
      })
      .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  } catch {
    return [];
  }
}

async function synthesizeInsertTextFromRange(
  ledgerPath: string,
  input: ContextLedgerMemoryInput,
): Promise<string | null> {
  const sinceMs = normalizePositiveInt(input.since_ms);
  const untilMs = normalizePositiveInt(input.until_ms);
  if (!sinceMs || !untilMs || sinceMs > untilMs) return null;

  const entries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const ranged = entries.filter((entry) => entry.timestamp_ms >= sinceMs && entry.timestamp_ms <= untilMs);
  if (ranged.length === 0) return null;

  return ranged
    .map((entry) => `[${entry.timestamp_iso}] ${entry.event_type}: ${buildPreview(JSON.stringify(entry.payload), 220)}`)
    .join('\n');
}

function ensureReadableAgent(
  currentAgentId: string,
  targetAgentId: string,
  canReadAll: boolean,
  readableAgents: string[],
): void {
  const normalize = (raw: string): string => raw.trim().replaceAll('\\', '_').replaceAll('/', '_').replaceAll(':', '_');
  const current = normalize(currentAgentId);
  const target = normalize(targetAgentId);
  if (current === target) return;
  if (canReadAll) return;
  if (readableAgents.map(normalize).includes(target)) return;
  throw new Error(`permission denied to read ledger for agent '${targetAgentId}'`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
