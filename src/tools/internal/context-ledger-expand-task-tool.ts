import { executeContextLedgerMemory } from '../../runtime/context-ledger-memory.js';
import {
  containsPromptLikeBlock,
  normalizeRootDir,
  readJsonLines,
  resolveLedgerPath,
  valueAsString,
} from '../../runtime/context-ledger-memory-helpers.js';
import type { LedgerEntryFile } from '../../runtime/context-ledger-memory-types.js';
import type { ContextLedgerMemoryQueryResult } from '../../runtime/context-ledger-memory-types.js';
import type { InternalTool, ToolExecutionContext } from './types.js';

interface ContextLedgerExpandTaskInput {
  session_id?: string;
  agent_id?: string;
  mode?: string;
  task_id?: string;
  slot_start?: number;
  slot_end?: number;
  _runtime_context?: Record<string, unknown>;
}

interface ContextLedgerExpandTaskOutput {
  ok: boolean;
  action: 'expand_task';
  sessionId: string;
  agentId: string;
  taskId?: string;
  slotStart: number;
  slotEnd: number;
  total: number;
  source: string;
  entries: ContextLedgerMemoryQueryResult['entries'];
  slots: ContextLedgerMemoryQueryResult['slots'];
  note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseInput(rawInput: unknown): ContextLedgerExpandTaskInput {
  if (!isRecord(rawInput)) return {};
  return {
    session_id: typeof rawInput.session_id === 'string' ? rawInput.session_id : undefined,
    agent_id: typeof rawInput.agent_id === 'string' ? rawInput.agent_id : undefined,
    mode: typeof rawInput.mode === 'string' ? rawInput.mode : undefined,
    task_id: typeof rawInput.task_id === 'string' ? rawInput.task_id : undefined,
    slot_start: typeof rawInput.slot_start === 'number' ? rawInput.slot_start : undefined,
    slot_end: typeof rawInput.slot_end === 'number' ? rawInput.slot_end : undefined,
    _runtime_context: isRecord(rawInput._runtime_context) ? rawInput._runtime_context : undefined,
  };
}

function normalizeRuntimeContext(
  input: ContextLedgerExpandTaskInput,
  context: ToolExecutionContext,
): { sessionId: string; agentId: string; mode: string } {
  const runtime = input._runtime_context && isRecord(input._runtime_context)
    ? input._runtime_context
    : {};
  const sessionId = (
    input.session_id
    ?? (typeof runtime.session_id === 'string' ? runtime.session_id : undefined)
    ?? context.sessionId
    ?? ''
  ).trim();
  const agentId = (
    input.agent_id
    ?? (typeof runtime.agent_id === 'string' ? runtime.agent_id : undefined)
    ?? context.agentId
    ?? ''
  ).trim();
  const mode = (
    input.mode
    ?? (typeof runtime.mode === 'string' ? runtime.mode : undefined)
    ?? 'main'
  ).trim() || 'main';
  if (!sessionId) throw new Error('context_ledger.expand_task requires session_id (or active tool context sessionId)');
  if (!agentId) throw new Error('context_ledger.expand_task requires agent_id (or active tool context agentId)');
  return { sessionId, agentId, mode };
}

function isQueryResult(result: unknown): result is ContextLedgerMemoryQueryResult {
  return isRecord(result) && (result.action === 'query' || result.action === 'search');
}

function roleOfLedgerEntry(entry: LedgerEntryFile): string {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  return valueAsString(payload.role) ?? 'system';
}

function isReasoningStopLedgerBoundary(entry: LedgerEntryFile): boolean {
  const payload = isRecord(entry.payload) ? entry.payload : {};
  const content = valueAsString(payload.content) ?? '';
  if (/\breasoning\.stop\b/i.test(content)) return true;
  const metadata = isRecord(payload.metadata) ? payload.metadata : undefined;
  if (!metadata) return false;
  const directTool = valueAsString(metadata.toolName) ?? valueAsString(metadata.tool);
  if (directTool === 'reasoning.stop') return true;
  const event = isRecord(metadata.event) ? metadata.event : undefined;
  const eventTool = event ? (valueAsString(event.toolName) ?? valueAsString(event.tool)) : undefined;
  return eventTool === 'reasoning.stop';
}

function extractTaskIdCandidates(rawTaskId: string): string[] {
  const normalized = rawTaskId.trim();
  if (!normalized) return [];
  const candidates = new Set<string>([normalized]);
  const directTaskMatch = normalized.match(/task-\d{6,}/i)?.[0];
  if (directTaskMatch) candidates.add(directTaskMatch);
  if (normalized.startsWith('digest-task-')) {
    candidates.add(normalized.replace(/^digest-task-/i, 'task-'));
  }
  if (normalized.startsWith('compact-task-digest-task-')) {
    candidates.add(normalized.replace(/^compact-task-digest-/i, ''));
  }
  return Array.from(candidates.values());
}

function parseTaskTimestamp(taskIdCandidates: string[]): number | undefined {
  for (const candidate of taskIdCandidates) {
    const matched = candidate.match(/task-(\d{6,})$/i);
    if (!matched) continue;
    const parsed = Number(matched[1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

async function resolveSlotRangeByTaskIdFromFullLedger(params: {
  taskId: string;
  sessionId: string;
  agentId: string;
  mode: string;
  rootDir?: string;
}): Promise<{ slotStart: number; slotEnd: number } | null> {
  const taskIdCandidates = extractTaskIdCandidates(params.taskId);
  if (taskIdCandidates.length === 0) return null;
  const rootDir = normalizeRootDir(params.rootDir);
  const ledgerPath = resolveLedgerPath(rootDir, params.sessionId, params.agentId, params.mode);
  const fullEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const sanitized = fullEntries
    .filter((entry) => !containsPromptLikeBlock(`${entry.event_type}\n${JSON.stringify(entry.payload)}`))
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  if (sanitized.length === 0) return null;

  const ranges: Array<{ startIndex: number; endIndex: number }> = [];
  let currentStartIndex = 0;

  const flush = (endIndex: number) => {
    if (endIndex < currentStartIndex) return;
    ranges.push({ startIndex: currentStartIndex, endIndex });
  };

  for (let index = 0; index < sanitized.length; index += 1) {
    const entry = sanitized[index];
    const role = roleOfLedgerEntry(entry);
    const eventType = entry.event_type ?? '';
    /**
     * Task boundary detection (dual-approach):
     * - session_message with role='user' starts a new task (legacy/test fixture support)
     * - turn_start also starts a new task (production ledger support)
     */
    const isUserBoundary = eventType === 'session_message' && role === 'user' && index > currentStartIndex;
    const isTurnBoundary = eventType === 'turn_start' && index > currentStartIndex;
    if (isUserBoundary || isTurnBoundary) {
      flush(index - 1);
      currentStartIndex = index;
      continue;
    }
    if (isReasoningStopLedgerBoundary(entry)) {
      flush(index);
      currentStartIndex = index + 1;
    }
  }
  flush(sanitized.length - 1);
  if (ranges.length === 0) return null;

  for (const range of ranges) {
    const taskId = `task-${sanitized[range.startIndex]?.timestamp_ms ?? 0}`;
    if (taskIdCandidates.includes(taskId)) {
      return {
        slotStart: range.startIndex + 1,
        slotEnd: range.endIndex + 1,
      };
    }
  }

  const targetTimestamp = parseTaskTimestamp(taskIdCandidates);
  if (!targetTimestamp) return null;
  const targetIndex = sanitized.findIndex((entry) => entry.timestamp_ms === targetTimestamp);
  if (targetIndex < 0) return null;
  const range = ranges.find((item) => item.startIndex <= targetIndex && targetIndex <= item.endIndex);
  if (!range) return null;
  return {
    slotStart: range.startIndex + 1,
    slotEnd: range.endIndex + 1,
  };
}

export const contextLedgerExpandTaskTool: InternalTool<unknown, ContextLedgerExpandTaskOutput> = {
  name: 'context_ledger.expand_task',
  executionModel: 'state',
  description: [
    'Expand one compact task digest into full ledger entries.',
    'Use task_id or slot_start/slot_end to fetch the original detailed timeline for that task.',
    'Internally delegates to context_ledger.memory query(detail=true).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Optional session id override. Usually auto-filled by runtime.' },
      agent_id: { type: 'string', description: 'Target agent ledger id. Usually auto-filled by runtime.' },
      mode: { type: 'string', description: 'Conversation mode/thread name. Defaults to main.' },
      task_id: { type: 'string', description: 'Task block id from digest/task_blocks (preferred).' },
      slot_start: { type: 'number', description: '1-based start slot. Use with slot_end when task_id is unknown.' },
      slot_end: { type: 'number', description: '1-based end slot. Use with slot_start when task_id is unknown.' },
    },
    additionalProperties: true,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ContextLedgerExpandTaskOutput> => {
    const input = parseInput(rawInput);
    const { sessionId, agentId, mode } = normalizeRuntimeContext(input, context);
    const runtimeContext = input._runtime_context && isRecord(input._runtime_context)
      ? input._runtime_context
      : undefined;

    let slotStart = input.slot_start;
    let slotEnd = input.slot_end;
    const taskId = input.task_id?.trim();

    if ((slotStart === undefined || slotEnd === undefined) && taskId) {
      const searchResult = await executeContextLedgerMemory({
        action: 'search',
        session_id: sessionId,
        agent_id: agentId,
        mode,
        limit: 500,
        ...(runtimeContext ? { _runtime_context: runtimeContext } : {}),
      });
      if (!isQueryResult(searchResult)) {
        throw new Error('context_ledger.expand_task failed: unexpected search result shape');
      }
      const hit = searchResult.task_blocks.find((block) => block.id === taskId);
      if (!hit) {
        const fallbackRange = await resolveSlotRangeByTaskIdFromFullLedger({
          taskId,
          sessionId,
          agentId,
          mode,
          rootDir: runtimeContext && typeof runtimeContext.root_dir === 'string'
            ? runtimeContext.root_dir
            : undefined,
        });
        if (!fallbackRange) {
          throw new Error(`context_ledger.expand_task failed: task_id not found (${taskId})`);
        }
        slotStart = fallbackRange.slotStart;
        slotEnd = fallbackRange.slotEnd;
      } else {
        slotStart = hit.start_slot;
        slotEnd = hit.end_slot;
      }
    }

    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) {
      throw new Error('context_ledger.expand_task requires task_id or slot_start+slot_end');
    }

    const queryResult = await executeContextLedgerMemory({
      action: 'query',
      detail: true,
      session_id: sessionId,
      agent_id: agentId,
      mode,
      slot_start: Math.floor(slotStart as number),
      slot_end: Math.floor(slotEnd as number),
      limit: 500,
      ...(runtimeContext ? { _runtime_context: runtimeContext } : {}),
    });
    if (!isQueryResult(queryResult)) {
      throw new Error('context_ledger.expand_task failed: unexpected query result shape');
    }

    return {
      ok: true,
      action: 'expand_task',
      sessionId,
      agentId,
      ...(taskId ? { taskId } : {}),
      slotStart: queryResult.slot_start,
      slotEnd: queryResult.slot_end,
      total: queryResult.total,
      source: queryResult.source,
      entries: queryResult.entries,
      slots: queryResult.slots,
      note: 'Expanded task digest to full ledger entries via context_ledger.memory query(detail=true).',
    };
  },
};
