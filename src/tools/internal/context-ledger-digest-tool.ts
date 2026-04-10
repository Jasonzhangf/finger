/**
 * Context Ledger Digest Query Tool
 *
 * Query task digests from compact-memory.jsonl for session history analysis.
 */

import { InternalTool, ToolExecutionContext } from './types.js';
import {
  resolveCompactMemoryPath,
  normalizeRootDir,
  readJsonLines,
  valueAsString,
} from '../../runtime/context-ledger-memory-helpers.js';
import type { CompactMemorySearchEntry } from '../../runtime/context-ledger-memory-types.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';

interface DigestQueryInput {
  action: 'list' | 'get' | 'search';
  session_id?: string;
  agent_id?: string;
  mode?: string;
  digest_id?: string;
  task_id?: string;
  contains?: string;
  limit?: number;
  since_ms?: number;
  until_ms?: number;
}

interface DigestQueryOutput {
  ok: boolean;
  action: string;
  digests?: CompactMemorySearchEntry[];
  digest?: CompactMemorySearchEntry;
  total?: number;
  error?: string;
}

// Local helper functions (not exported from helpers module)
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function valueAsNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveDigestEntry(entry: Record<string, unknown>): CompactMemorySearchEntry {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  return {
    id: valueAsString(entry.id) ?? '',
    timestamp_ms: valueAsNumber(entry.timestamp_ms) ?? 0,
    timestamp_iso: valueAsString(entry.timestamp_iso) ?? '',
    summary: valueAsString(payload.summary) ?? '',
    source_time_start: valueAsString(payload.source_time_start),
    source_time_end: valueAsString(payload.source_time_end),
    source_slot_start: valueAsNumber(payload.source_slot_start),
    source_slot_end: valueAsNumber(payload.source_slot_end),
    trigger: valueAsString(payload.trigger) as 'manual' | 'auto' | undefined,
    linked_event_ids: Array.isArray(payload.linked_event_ids) ? payload.linked_event_ids.map(String) : undefined,
    linked_message_ids: Array.isArray(payload.linked_message_ids) ? payload.linked_message_ids.map(String) : undefined,
  };
}

async function executeDigestQuery(input: DigestQueryInput, context: ToolExecutionContext): Promise<DigestQueryOutput> {
  const rootDir = normalizeRootDir(FINGER_PATHS.sessions.dir);
  const sessionId = input.session_id ?? context.sessionId ?? '';
  const agentId = input.agent_id ?? context.agentId ?? 'finger-project-agent';
  const mode = input.mode ?? 'main';

  if (!sessionId) {
    return { ok: false, action: input.action, error: 'session_id is required' };
  }

  const compactPath = resolveCompactMemoryPath(rootDir, sessionId, agentId, mode);

  try {
    const rawEntries = await readJsonLines<Record<string, unknown>>(compactPath);
    const digests: CompactMemorySearchEntry[] = rawEntries
      .filter((entry: Record<string, unknown>) => {
        const payload = isRecord(entry.payload) ? entry.payload : {};
        const trigger = valueAsString(payload.trigger);
        return trigger === 'auto' || trigger === 'manual';
      })
      .map(resolveDigestEntry);

    if (input.action === 'list') {
      const limit = Math.min(Math.max(1, input.limit ?? 50), 500);
      let filtered = digests;

      if (input.since_ms) {
        filtered = filtered.filter((d: CompactMemorySearchEntry) => d.timestamp_ms >= input.since_ms!);
      }
      if (input.until_ms) {
        filtered = filtered.filter((d: CompactMemorySearchEntry) => d.timestamp_ms <= input.until_ms!);
      }

      const sorted = filtered.sort((a: CompactMemorySearchEntry, b: CompactMemorySearchEntry) => b.timestamp_ms - a.timestamp_ms).slice(0, limit);

      return {
        ok: true,
        action: 'list',
        digests: sorted,
        total: sorted.length,
      };
    }

    if (input.action === 'get') {
      const digestId = input.digest_id ?? input.task_id;
      if (!digestId) {
        return { ok: false, action: 'get', error: 'digest_id or task_id is required' };
      }

      const digest = digests.find((d: CompactMemorySearchEntry) => d.id === digestId);
      if (!digest) {
        return { ok: false, action: 'get', error: `digest not found: ${digestId}` };
      }

      return { ok: true, action: 'get', digest };
    }

    if (input.action === 'search') {
      const query = input.contains?.toLowerCase()?.trim() ?? '';
      const limit = Math.min(Math.max(1, input.limit ?? 20), 100);

      const matched = digests
        .filter((d: CompactMemorySearchEntry) => {
          if (!query) return true;
          return d.summary.toLowerCase().includes(query);
        })
        .sort((a: CompactMemorySearchEntry, b: CompactMemorySearchEntry) => b.timestamp_ms - a.timestamp_ms)
        .slice(0, limit);

      return {
        ok: true,
        action: 'search',
        digests: matched,
        total: matched.length,
      };
    }

    return { ok: false, action: input.action, error: `unknown action: ${input.action}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { ok: false, action: input.action, error: 'compact-memory.jsonl not found for session' };
    }
    return { ok: false, action: input.action, error: error instanceof Error ? error.message : String(error) };
  }
}

export const contextLedgerDigestTool: InternalTool<unknown, DigestQueryOutput> = {
  name: 'context_ledger.digest',
  executionModel: 'state',
  description: [
    'Query task digests from compact memory for session history analysis.',
    'Use action=list to get all digests, action=get for specific digest by ID.',
    'Use action=search with contains keyword to filter digests by summary.',
    'Digests contain task-level summaries with source slot ranges for drill-down.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'search'],
        description: 'list: all digests; get: specific digest; search: keyword filter',
      },
      session_id: { type: 'string', description: 'Target session ID (defaults to current session)' },
      agent_id: { type: 'string', description: 'Agent ID (defaults to finger-project-agent)' },
      mode: { type: 'string', description: 'Session mode (defaults to main)' },
      digest_id: { type: 'string', description: 'Digest ID to retrieve (for action=get)' },
      task_id: { type: 'string', description: 'Task ID to match (alias for digest_id)' },
      contains: { type: 'string', description: 'Keyword to search in digest summaries' },
      limit: { type: 'number', description: 'Max results (default 50, max 500)' },
      since_ms: { type: 'number', description: 'Unix ms start time filter' },
      until_ms: { type: 'number', description: 'Unix ms end time filter' },
    },
    required: ['action'],
  },
  execute: async (input: unknown, context: ToolExecutionContext) => {
    const parsed = input as DigestQueryInput;
    return executeDigestQuery(parsed, context);
  },
};
