import { existsSync } from 'fs';
import { join } from 'path';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';
import { runSpawnCommand } from './spawn-runner.js';
import { InternalTool, ToolExecutionContext } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const TOOL_INPUT_ENV_KEY = 'FINGER_CONTEXT_LEDGER_TOOL_INPUT';

interface ContextLedgerMemoryToolInput {
  action?: 'query' | 'search' | 'index' | 'compact';
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
  description: [
    'Time-ordered context memory tool with two-level retrieval.',
    'Query timeline ledger by time range / keyword / event type.',
    'For fuzzy queries, it checks compact memory first; then detail query can drill into raw timeline.',
    'Read-only for agents: query/search timeline memory.',
    'System-level maintenance actions compact/index are allowed for automatic ledger maintenance.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'search', 'index', 'compact'], description: 'query/search: search timeline memory; index: rebuild compact index; compact: persist a compaction summary and align ledger' },
      session_id: { type: 'string', description: 'Optional override session id; usually auto-filled by runtime context' },
      agent_id: { type: 'string', description: 'Target agent ledger id. Requires read permission when not self.' },
      mode: { type: 'string', description: 'Conversation mode/thread name, e.g. main or review' },
      since_ms: { type: 'number', description: 'Unix milliseconds start boundary (inclusive)' },
      until_ms: { type: 'number', description: 'Unix milliseconds end boundary (inclusive)' },
      limit: { type: 'number', description: 'Max records to return, default 50, max 500' },
      slot_start: { type: 'number', description: '1-based slot start for query detail retrieval' },
      slot_end: { type: 'number', description: '1-based slot end for query detail retrieval' },
      contains: { type: 'string', description: 'Keyword query; fuzzy search supported' },
      fuzzy: { type: 'boolean', description: 'When true, fuzzy query checks compact memory first' },
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
   },
   required: ['action'],
   additionalProperties: true,
 },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ContextLedgerMemoryToolOutput> => {
    const input = parseInput(rawInput);
    const invocation = resolveCliInvocation();
    const commandArray = [...invocation, 'memory-ledger', 'run', '--from-env', '--json-line'];

    const execution = await runSpawnCommand({
      commandArray,
      cwd: context.cwd,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      env: {
        [TOOL_INPUT_ENV_KEY]: JSON.stringify(input),
      },
    });

    const stdout = execution.stdout.trim();
    if (execution.exitCode !== 0 || execution.timedOut) {
      const detail = execution.stderr.trim() || stdout || 'unknown error';
      throw new Error(`context_ledger.memory cli failed: ${detail}`);
    }
    if (stdout.length === 0) {
      throw new Error('context_ledger.memory cli returned empty output');
    }

    const candidateLine = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .at(-1);
    if (!candidateLine) {
      throw new Error('context_ledger.memory cli returned empty output');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidateLine);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`context_ledger.memory output is not JSON: ${message}`);
    }

    if (!isRecord(parsed)) {
      throw new Error('context_ledger.memory output must be object');
    }

    return parsed as ContextLedgerMemoryToolOutput;
  },
};

function resolveCliInvocation(): string[] {
  const envBin = process.env.FINGER_CLI_BIN?.trim();
  if (envBin && envBin.length > 0) {
    return [envBin];
  }

  const distCli = join(FINGER_SOURCE_ROOT, 'dist', 'cli', 'index.js');
  if (existsSync(distCli)) {
    return [process.execPath, distCli];
  }

  return ['myfinger'];
}

function parseInput(rawInput: unknown): ContextLedgerMemoryToolInput {
  if (!isRecord(rawInput)) {
    return { action: 'query' };
  }
  const action = rawInput.action === 'index'
    || rawInput.action === 'compact'
    || rawInput.action === 'search'
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
    replacement_history: Array.isArray(rawInput.replacement_history)
      ? rawInput.replacement_history.filter((item): item is Record<string, unknown> => isRecord(item))
      : undefined,
    _runtime_context: isRecord(rawInput._runtime_context) ? rawInput._runtime_context : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
