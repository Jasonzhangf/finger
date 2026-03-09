import { promises as fs } from 'fs';
import type {
  CompactMemoryEntryFile,
  CompactMemorySearchEntry,
  ContextLedgerMemoryCompactResult,
  ContextLedgerMemoryIndexResult,
  ContextLedgerMemoryInput,
  ContextLedgerMemoryQueryResult,
  ContextLedgerMemoryResult,
  LedgerEntryFile,
} from './context-ledger-memory-types.js';
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
      timeline: [],
      total: 0,
      truncated: false,
      compact_hits: compactHits,
      compact_source: compactEntries.length > 0 ? compactIndexPath : compactPath,
      compact_total: compactHits.length,
      compact_truncated: false,
      next_query_hint: {
        action: 'query',
        detail: true,
        since_ms: toTimestampMs(compactHits[0].source_time_start),
        until_ms: toTimestampMs(compactHits[0].source_time_end),
        contains: query.contains,
        fuzzy: false,
      },
      note: 'Fuzzy query matched compact memory first. Use next_query_hint for detail retrieval from full timeline ledger.',
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
  const paged = paginate(detailHits, query.limit);

  return {
    ok: true,
    action: input.action === 'search' ? 'search' : 'query',
    strategy: shouldUseCompactFirst && compactHits.length > 0 ? 'compact_then_detail' : 'direct_ledger',
    source: ledgerPath,
    entries: paged.items,
    timeline: paged.items.map((entry) => ({
      id: entry.id,
      timestamp_ms: entry.timestamp_ms,
      timestamp_iso: entry.timestamp_iso,
      event_type: entry.event_type,
      agent_id: entry.agent_id,
      mode: entry.mode,
      preview: buildPreview(JSON.stringify(entry.payload), 180),
    })),
    total: paged.total,
    truncated: paged.truncated,
      compact_hits: compactHits,
    compact_source: compactEntries.length > 0 ? compactIndexPath : compactPath,
    compact_total: compactHits.length,
    compact_truncated: false,
      note: shouldUseCompactFirst
      ? 'Fuzzy query looked up compact memory first, then fetched detailed timeline records.'
      : 'Direct timeline query executed against append-only ledger.',
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

function buildCompactSummaryFromEntries(entries: LedgerEntryFile[]): string {
  if (entries.length === 0) return '(no summary available)';
  const previews = entries
    .slice(-6)
    .map((entry) => `[${entry.event_type}] ${buildPreview(JSON.stringify(entry.payload), 120)}`);
  return previews.join('\n');
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
