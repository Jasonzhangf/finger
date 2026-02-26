import { existsSync } from 'fs';
import { join } from 'path';
import { runSpawnCommand } from './spawn-runner.js';
import { InternalTool, ToolExecutionContext } from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const TOOL_INPUT_ENV_KEY = 'FINGER_CONTEXT_LEDGER_TOOL_INPUT';

interface ContextLedgerMemoryToolInput {
  action?: 'query' | 'insert';
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
    'Can insert important text or a time-range slice into focus slot (ledger carry area).',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['query', 'insert'], description: 'query: search timeline memory; insert: write focus slot' },
      session_id: { type: 'string', description: 'Optional override session id; usually auto-filled by runtime context' },
      agent_id: { type: 'string', description: 'Target agent ledger id. Requires read permission when not self.' },
      mode: { type: 'string', description: 'Conversation mode/thread name, e.g. main or review' },
      since_ms: { type: 'number', description: 'Unix milliseconds start boundary (inclusive)' },
      until_ms: { type: 'number', description: 'Unix milliseconds end boundary (inclusive)' },
      limit: { type: 'number', description: 'Max records to return, default 50, max 500' },
      contains: { type: 'string', description: 'Keyword query; fuzzy search supported' },
      fuzzy: { type: 'boolean', description: 'When true, fuzzy query checks compact memory first' },
      event_types: { type: 'array', items: { type: 'string' }, description: 'Filter by event types, e.g. tool_call/tool_result/context_compact' },
      detail: { type: 'boolean', description: 'For fuzzy compact hit, drill down into raw timeline details' },
      text: { type: 'string', description: 'Text to insert into focus slot for carry-forward context' },
      append: { type: 'boolean', description: 'Append to existing focus slot content instead of overwrite' },
      focus_max_chars: { type: 'number', description: 'Optional focus-slot char limit override' },
    },
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

  const distCli = join(process.cwd(), 'dist', 'cli', 'index.js');
  if (existsSync(distCli)) {
    return [process.execPath, distCli];
  }

  return ['myfinger'];
}

function parseInput(rawInput: unknown): ContextLedgerMemoryToolInput {
  if (!isRecord(rawInput)) {
    return { action: 'query' };
  }
  const action = rawInput.action === 'insert' ? 'insert' : 'query';
  return {
    action,
    session_id: typeof rawInput.session_id === 'string' ? rawInput.session_id : undefined,
    agent_id: typeof rawInput.agent_id === 'string' ? rawInput.agent_id : undefined,
    mode: typeof rawInput.mode === 'string' ? rawInput.mode : undefined,
    since_ms: typeof rawInput.since_ms === 'number' ? rawInput.since_ms : undefined,
    until_ms: typeof rawInput.until_ms === 'number' ? rawInput.until_ms : undefined,
    limit: typeof rawInput.limit === 'number' ? rawInput.limit : undefined,
    contains: typeof rawInput.contains === 'string' ? rawInput.contains : undefined,
    fuzzy: rawInput.fuzzy === true,
    event_types: Array.isArray(rawInput.event_types)
      ? rawInput.event_types.filter((item): item is string => typeof item === 'string')
      : undefined,
    detail: rawInput.detail === true,
    text: typeof rawInput.text === 'string' ? rawInput.text : undefined,
    append: rawInput.append === true,
    focus_max_chars: typeof rawInput.focus_max_chars === 'number' ? rawInput.focus_max_chars : undefined,
    _runtime_context: isRecord(rawInput._runtime_context) ? rawInput._runtime_context : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
