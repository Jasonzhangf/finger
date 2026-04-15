export type ContextLedgerMemoryAction =
  | 'query'
  | 'search'
  | 'insert'
  | 'index'
  | 'compact'
  | 'delete_slots'
  | 'digest_backfill'
  | 'digest_incremental';

export interface ContextLedgerMemoryRuntimeContext {
  root_dir?: string;
  session_id?: string;
  agent_id?: string;
  mode?: string;
  track?: string;        // 多轨：运行时 track 信息
  can_read_all?: boolean;
  readable_agents?: string[];
  focus_max_chars?: number;
  context_history?: {
    working_set_block_ids?: string[];
    historical_block_ids?: string[];
    ranking_ids?: string[];
    raw_task_block_count?: number;
    filtered_task_block_count?: number;
  };
}

export interface ContextLedgerMemoryInput {
  action?: ContextLedgerMemoryAction;
  session_id?: string;
  agent_id?: string;
  mode?: string;
  track?: string;        // 多轨：按轨道过滤
  since_ms?: number;
  until_ms?: number;
  limit?: number;
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
  slot_start?: number;
  slot_end?: number;
  source_message_ids?: string[];
  source_event_ids?: string[];
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
  _runtime_context?: ContextLedgerMemoryRuntimeContext;
}

export interface LedgerEntryFile {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  track?: string;        // 多轨：该条目所属轨道（默认 track0）
  role?: string;
  event_type: string;
  payload: unknown;
}

export interface CompactMemoryEntryFile {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id?: string;
  agent_id?: string;
  mode?: string;
  track?: string;        // 多轨：压缩条目所属轨道
  payload: Record<string, unknown>;
}

export interface CompactMemorySearchEntry {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  summary: string;
  track?: string;        // 多轨：该摘要所属轨道
  source_time_start?: string;
  source_time_end?: string;
  source_slot_start?: number;
  source_slot_end?: number;
  trigger?: 'manual' | 'auto';
  linked_event_ids?: string[];
  linked_message_ids?: string[];
}

export interface ContextLedgerMemoryQueryResult {
  ok: true;
  action: 'query' | 'search';
  strategy: 'direct_ledger' | 'compact_first' | 'compact_then_detail';
  source: string;
  entries: LedgerEntryFile[];
  slots: Array<{
    slot: number;
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    event_type: string;
    agent_id: string;
    mode: string;
    preview: string;
  }>;
  timeline: Array<{
    slot: number;
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    event_type: string;
    agent_id: string;
    mode: string;
    preview: string;
  }>;
  slot_start: number;
  slot_end: number;
  total: number;
  truncated: boolean;
  compact_hits: Array<{
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    summary: string;
    source_time_start?: string;
    source_time_end?: string;
    source_slot_start?: number;
    source_slot_end?: number;
    track?: string;
    trigger?: 'manual' | 'auto';
    preview: string;
  }>;
  compact_source: string;
  compact_total: number;
  compact_truncated: boolean;
  task_blocks: Array<{
    id: string;
    start_slot: number;
    end_slot: number;
    start_time_ms: number;
    end_time_ms: number;
    start_time_iso: string;
    end_time_iso: string;
    preview: string;
    tags?: string[];
    topic?: string;
    score?: number;
    match_reason: 'keyword' | 'embedding' | 'keyword+embedding' | 'recency';
    visibility: 'working_set' | 'historical_memory' | 'omitted_history' | 'unknown';
    detail_query_hint: {
      action: 'query';
      detail: true;
      slot_start: number;
      slot_end: number;
    };
  }>;
  context_bridge: {
    searched_full_ledger: boolean;
    total_slots: number;
    note: string;
    working_set_block_ids?: string[];
    historical_block_ids?: string[];
  };
  next_query_hint?: Record<string, unknown>;
  note: string;
}

export interface ContextLedgerMemoryInsertResult {
  ok: true;
  action: 'insert';
  chars: number;
  truncated: boolean;
  focus_path: string;
}

export interface ContextLedgerMemoryIndexResult {
  ok: true;
  action: 'index';
  compact_source: string;
  compact_index_path: string;
  entries_indexed: number;
  full_reindex: boolean;
}

export interface ContextLedgerMemoryCompactResult {
  ok: true;
  action: 'compact';
  compaction_id: string;
  summary: string;
  trigger: 'manual' | 'auto';
  compact_path: string;
  compact_index_path: string;
  source_time_start?: string;
  source_time_end?: string;
  source_slot_start?: number;
  source_slot_end?: number;
  track?: string;
  linked_event_ids: string[];
  linked_message_ids: string[];
  indexed: boolean;
}

export interface ContextLedgerMemoryDeleteSlotsResult {
  ok: true;
  action: 'delete_slots';
  source: string;
  target_agent_id: string;
  selected_slots: Array<{
    slot: number;
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    event_type: string;
    preview: string;
  }>;
  selected_total: number;
  deleted_count: number;
  preview_only: boolean;
  requires_confirmation: boolean;
  reason?: string;
  intent_id?: string;
  confirmation_phrase?: string;
  note: string;
}

export interface ContextLedgerMemoryDigestBackfillResult {
  ok: true;
  action: 'digest_backfill';
  compact_path: string;
  compact_index_path: string;
  task_digest_count: number;
  linked_event_count: number;
  linked_message_count: number;
  note: string;
}

export interface ContextLedgerMemoryDigestIncrementalResult {
  ok: true;
  action: 'digest_incremental';
  compact_path: string;
  compact_index_path: string;
  task_digest_count: number;
  linked_event_count: number;
  linked_message_count: number;
  source_slot_start: number;
  source_slot_end: number;
  previous_compacted_slot_end: number;
  no_new_entries: boolean;
  note: string;
}

export type ContextLedgerMemoryResult =
  | ContextLedgerMemoryQueryResult
  | ContextLedgerMemoryInsertResult
  | ContextLedgerMemoryIndexResult
  | ContextLedgerMemoryCompactResult
  | ContextLedgerMemoryDeleteSlotsResult
  | ContextLedgerMemoryDigestBackfillResult
  | ContextLedgerMemoryDigestIncrementalResult;
