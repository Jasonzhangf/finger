import { executeContextLedgerMemory } from '../../runtime/context-ledger-memory.js';
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
        throw new Error(`context_ledger.expand_task failed: task_id not found (${taskId})`);
      }
      slotStart = hit.start_slot;
      slotEnd = hit.end_slot;
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
