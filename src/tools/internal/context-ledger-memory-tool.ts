import { executeContextLedgerMemory } from '../../runtime/context-ledger-memory.js';
import { InternalTool, ToolExecutionContext } from './types.js';

interface ContextLedgerMemoryToolInput {
  action?: 'query' | 'search' | 'index' | 'compact' | 'delete_slots' | 'digest_backfill' | 'digest_incremental';
  session_id?: string;
  agent_id?: string;
  mode?: string;
  since_ms?: number;
  until_ms?: number;
  limit?: number;
  slot_start?: number;
  slot_end?: number;
  contains?: string;
  fuzzy?: boolean;
  event_types?: string[];
  detail?: boolean;
  text?: string;
  append?: boolean;
  focus_max_chars?: number;
  full_reindex?: boolean;
  trigger?: 'manual' | 'auto';
  summary?: string;
  source_event_ids?: string[];
  source_message_ids?: string[];
  source_time_start?: string;
  source_time_end?: string;
  source_slot_start?: number;
  source_slot_end?: number;
  slot_ids?: number[];
  preview_only?: boolean;
  confirm?: boolean;
  user_confirmation?: string;
  reason?: string;
  user_authorized?: boolean;
  intent_id?: string;
  replacement_history?: Array<Record<string, unknown>>;
  _runtime_context?: Record<string, unknown>;
}

export interface ContextLedgerMemoryToolOutput {
  ok?: boolean;
  action?: string;
  [key: string]: unknown;
}

export const contextLedgerMemoryTool: InternalTool<unknown, ContextLedgerMemoryToolOutput> = {
  name: 'context_ledger.memory',
  executionModel: 'state',
  description: [
    'Canonical time-ordered ledger history tool with two-level retrieval.',
    'Use it when visible prompt history is incomplete or budgeted and you need prior decisions, evidence, or raw timeline details.',
    'Default dynamic history budget is 20k tokens; for topic switches or coding work that needs more context, pair this with context_builder.rebuild (try rebuild_budget=50000 before 110000).',
    'Search can use compact/fuzzy/task-block recall to find relevant overflow-history windows; query with detail=true can drill into raw ledger entries by slot range.',
    'Read-only for normal agent retrieval: query/search timeline memory.',
    'System-level maintenance actions compact/index are allowed for automatic ledger maintenance.',
    'Dangerous action delete_slots requires interactive user authorization and explicit confirmation token.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'search', 'index', 'compact', 'delete_slots', 'digest_backfill', 'digest_incremental'], description: 'Use search first to find relevant history, then query with detail=true for raw entries. digest_backfill can generate full digests; digest_incremental appends digest only for newly added ledger slots since last compaction.' },
      session_id: { type: 'string', description: 'Optional override session id; usually auto-filled by runtime context' },
      agent_id: { type: 'string', description: 'Target agent ledger id. Requires read permission when not self.' },
      mode: { type: 'string', description: 'Conversation mode/thread name, e.g. main or review' },
      since_ms: { type: 'number', description: 'Unix milliseconds start boundary (inclusive)' },
      until_ms: { type: 'number', description: 'Unix milliseconds end boundary (inclusive)' },
      limit: { type: 'number', description: 'Max records to return, default 50, max 500' },
      slot_start: { type: 'number', description: '1-based slot start for raw detail retrieval after search identified a relevant range' },
      slot_end: { type: 'number', description: '1-based slot end for raw detail retrieval after search identified a relevant range' },
      contains: { type: 'string', description: 'Keyword/topic query; use for search when history details are missing from prompt. Search also returns task-block candidates with detail_query_hint.' },
      fuzzy: { type: 'boolean', description: 'When true, search checks compact memory first and may use semantic/task-block recall before raw ledger lookup' },
      event_types: { type: 'array', items: { type: 'string' }, description: 'Filter by event types, e.g. tool_call/tool_result/context_compact' },
      detail: { type: 'boolean', description: 'When true on query, return raw ledger entries for the selected slot window' },
      text: { type: 'string', description: 'Reserved (disabled for agent manual writes)' },
      append: { type: 'boolean', description: 'Reserved (disabled for agent manual writes)' },
      focus_max_chars: { type: 'number', description: 'Reserved (disabled for agent manual writes)' },
      full_reindex: { type: 'boolean', description: 'Rebuild compact-memory index from scratch' },
      trigger: { type: 'string', enum: ['manual', 'auto'], description: 'Compaction trigger kind' },
      summary: { type: 'string', description: 'Compaction summary text' },
      source_event_ids: { type: 'array', items: { type: 'string' }, description: 'Original ledger event ids covered by compaction' },
      source_message_ids: { type: 'array', items: { type: 'string' }, description: 'Original session message ids covered by compaction' },
      source_time_start: { type: 'string', description: 'Original timeline start ISO timestamp' },
      source_time_end: { type: 'string', description: 'Original timeline end ISO timestamp' },
      source_slot_start: { type: 'number', description: 'Original timeline start slot' },
      source_slot_end: { type: 'number', description: 'Original timeline end slot' },
      slot_ids: { type: 'array', items: { type: 'number' }, description: 'For delete_slots: 1-based slot numbers to delete' },
      preview_only: { type: 'boolean', description: 'For delete_slots: when true, summarize candidate slots without deleting' },
      confirm: { type: 'boolean', description: 'For delete_slots: true means execute deletion (still requires confirmation token + user_authorized=true)' },
      user_confirmation: { type: 'string', description: 'For delete_slots: must equal the returned confirmation_phrase when confirm=true' },
      user_authorized: { type: 'boolean', description: 'For delete_slots: must be true only after explicit user consent in current interaction' },
      reason: { type: 'string', description: 'For delete_slots: user-provided reason for deletion' },
      intent_id: { type: 'string', description: 'For delete_slots: optional stable intent id for multi-step confirmation flow' },
    },
    required: ['action'],
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ContextLedgerMemoryToolOutput> => {
    const input = mergeRuntimeContext(parseInput(rawInput), context);
    const result = await executeContextLedgerMemory(input);
    return result as unknown as ContextLedgerMemoryToolOutput;
  },
};

function parseInput(rawInput: unknown): ContextLedgerMemoryToolInput {
  if (!isRecord(rawInput)) {
    return { action: 'query' };
  }
  const action = rawInput.action === 'index'
    || rawInput.action === 'compact'
    || rawInput.action === 'search'
    || rawInput.action === 'delete_slots'
    || rawInput.action === 'digest_backfill'
    || rawInput.action === 'digest_incremental'
      ? rawInput.action
      : 'query';

  if (rawInput.action === 'insert') {
    throw new Error('context_ledger.memory action=insert is disabled for manual tool calls; use query/search or automatic compact/index pipeline');
  }
  return {
    action,
    session_id: typeof rawInput.session_id === 'string' ? rawInput.session_id : undefined,
    agent_id: typeof rawInput.agent_id === 'string' ? rawInput.agent_id : undefined,
    mode: typeof rawInput.mode === 'string' ? rawInput.mode : undefined,
    since_ms: typeof rawInput.since_ms === 'number' ? rawInput.since_ms : undefined,
    until_ms: typeof rawInput.until_ms === 'number' ? rawInput.until_ms : undefined,
    limit: typeof rawInput.limit === 'number' ? rawInput.limit : undefined,
    slot_start: typeof rawInput.slot_start === 'number' ? rawInput.slot_start : undefined,
    slot_end: typeof rawInput.slot_end === 'number' ? rawInput.slot_end : undefined,
    contains: typeof rawInput.contains === 'string' ? rawInput.contains : undefined,
    fuzzy: rawInput.fuzzy === true,
    event_types: Array.isArray(rawInput.event_types)
      ? rawInput.event_types.filter((item): item is string => typeof item === 'string')
      : undefined,
    detail: rawInput.detail === true,
    text: typeof rawInput.text === 'string' ? rawInput.text : undefined,
    append: rawInput.append === true,
    focus_max_chars: typeof rawInput.focus_max_chars === 'number' ? rawInput.focus_max_chars : undefined,
    full_reindex: rawInput.full_reindex === true,
    trigger: rawInput.trigger === 'auto' ? 'auto' : rawInput.trigger === 'manual' ? 'manual' : undefined,
    summary: typeof rawInput.summary === 'string' ? rawInput.summary : undefined,
    source_event_ids: Array.isArray(rawInput.source_event_ids)
      ? rawInput.source_event_ids.filter((item): item is string => typeof item === 'string')
      : undefined,
    source_message_ids: Array.isArray(rawInput.source_message_ids)
      ? rawInput.source_message_ids.filter((item): item is string => typeof item === 'string')
      : undefined,
    source_time_start: typeof rawInput.source_time_start === 'string' ? rawInput.source_time_start : undefined,
    source_time_end: typeof rawInput.source_time_end === 'string' ? rawInput.source_time_end : undefined,
    source_slot_start: typeof rawInput.source_slot_start === 'number' ? rawInput.source_slot_start : undefined,
    source_slot_end: typeof rawInput.source_slot_end === 'number' ? rawInput.source_slot_end : undefined,
    slot_ids: Array.isArray(rawInput.slot_ids)
      ? rawInput.slot_ids.filter((item): item is number => typeof item === 'number')
      : undefined,
    preview_only: rawInput.preview_only === true,
    confirm: rawInput.confirm === true,
    user_confirmation: typeof rawInput.user_confirmation === 'string' ? rawInput.user_confirmation : undefined,
    reason: typeof rawInput.reason === 'string' ? rawInput.reason : undefined,
    user_authorized: rawInput.user_authorized === true,
    intent_id: typeof rawInput.intent_id === 'string' ? rawInput.intent_id : undefined,
    replacement_history: Array.isArray(rawInput.replacement_history)
      ? rawInput.replacement_history.filter((item): item is Record<string, unknown> => isRecord(item))
      : undefined,
    _runtime_context: isRecord(rawInput._runtime_context) ? rawInput._runtime_context : undefined,
  };
}

function mergeRuntimeContext(
  input: ContextLedgerMemoryToolInput,
  context: ToolExecutionContext,
): ContextLedgerMemoryToolInput {
  const runtimeContext = isRecord(input._runtime_context) ? { ...input._runtime_context } : {};
  if (!runtimeContext.session_id && context.sessionId) runtimeContext.session_id = context.sessionId;
  if (!runtimeContext.agent_id && context.agentId) runtimeContext.agent_id = context.agentId;

  return {
    ...input,
    session_id: input.session_id ?? context.sessionId,
    agent_id: input.agent_id ?? context.agentId,
    _runtime_context: runtimeContext,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
