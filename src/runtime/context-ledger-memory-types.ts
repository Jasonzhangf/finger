export type ContextLedgerMemoryAction = 'query' | 'insert';

export interface ContextLedgerMemoryRuntimeContext {
  root_dir?: string;
  session_id?: string;
  agent_id?: string;
  mode?: string;
  can_read_all?: boolean;
  readable_agents?: string[];
  focus_max_chars?: number;
}

export interface ContextLedgerMemoryInput {
  action?: ContextLedgerMemoryAction;
  session_id?: string;
  agent_id?: string;
  mode?: string;
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
  _runtime_context?: ContextLedgerMemoryRuntimeContext;
}

export interface LedgerEntryFile {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  role?: string;
  event_type: string;
  payload: unknown;
}

export interface CompactMemoryEntryFile {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  payload: Record<string, unknown>;
}

export interface CompactMemorySearchEntry {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  summary: string;
  source_time_start?: string;
  source_time_end?: string;
}

export interface ContextLedgerMemoryQueryResult {
  ok: true;
  action: 'query';
  strategy: 'direct_ledger' | 'compact_first' | 'compact_then_detail';
  source: string;
  entries: LedgerEntryFile[];
  timeline: Array<{
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    event_type: string;
    agent_id: string;
    mode: string;
    preview: string;
  }>;
  total: number;
  truncated: boolean;
  compact_hits: Array<{
    id: string;
    timestamp_ms: number;
    timestamp_iso: string;
    summary: string;
    source_time_start?: string;
    source_time_end?: string;
    preview: string;
  }>;
  compact_source: string;
  compact_total: number;
  compact_truncated: boolean;
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

export type ContextLedgerMemoryResult = ContextLedgerMemoryQueryResult | ContextLedgerMemoryInsertResult;
