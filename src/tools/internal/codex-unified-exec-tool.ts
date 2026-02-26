import { InternalTool, ToolExecutionContext } from './types.js';
import { execCommandTool, writeStdinTool } from './codex-exec-tools.js';

interface UnifiedExecInput {
  input: string[];
  session_id?: string;
  timeout_ms?: number;
}

interface UnifiedExecOutput {
  ok: boolean;
  exitCode: number;
  output: string;
  wall_time_seconds: number;
  original_token_count?: number;
  session_id?: number;
  termination: {
    type: 'exited' | 'ongoing';
    exitCode?: number;
    sessionId?: number;
  };
  text: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export const unifiedExecTool: InternalTool<unknown, UnifiedExecOutput> = {
  name: 'unified_exec',
  description: 'Runs a command in a PTY. Provide a session_id to reuse an existing interactive session.',
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'array',
        items: { type: 'string' },
        description:
          'When no session_id is provided, treat as command+args. When session_id is set, concatenate and write to stdin.',
      },
      session_id: {
        type: 'string',
        description: 'Identifier for an existing interactive session. If omitted, a new command is spawned.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum time in milliseconds to wait for output after writing the input.',
      },
    },
    required: ['input'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<UnifiedExecOutput> => {
    const input = parseUnifiedExecInput(rawInput);
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    if (!input.session_id) {
      if (input.input.length === 0) {
        throw new Error('unified_exec input cannot be empty when session_id is omitted');
      }
      const command = input.input.map(escapeShellArg).join(' ');
      const result = await execCommandTool.execute(
        {
          cmd: command,
          yield_time_ms: timeoutMs,
          shell: '/bin/bash',
          login: false,
        },
        context,
      );

      return {
        ok: result.ok,
        exitCode: result.exitCode,
        output: result.output,
        wall_time_seconds: result.wall_time_seconds,
        original_token_count: result.original_token_count,
        session_id: result.session_id,
        termination: result.termination,
        text: result.text,
      };
    }

    const sessionId = parseSessionId(input.session_id);
    const chars = input.input.join('');
    const result = await writeStdinTool.execute(
      {
        session_id: sessionId,
        chars,
        yield_time_ms: timeoutMs,
      },
      context,
    );

    return {
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output,
      wall_time_seconds: result.wall_time_seconds,
      original_token_count: result.original_token_count,
      session_id: result.session_id,
      termination: result.termination,
      text: result.text,
    };
  },
};

function parseUnifiedExecInput(rawInput: unknown): UnifiedExecInput {
  if (!isRecord(rawInput)) {
    throw new Error('unified_exec input must be an object');
  }

  if (!Array.isArray(rawInput.input)) {
    throw new Error('unified_exec input.input must be string[]');
  }
  const inputArray = rawInput.input.filter((item): item is string => typeof item === 'string');
  if (inputArray.length !== rawInput.input.length) {
    throw new Error('unified_exec input.input must contain only strings');
  }

  const parsed: UnifiedExecInput = {
    input: inputArray,
  };
  if (typeof rawInput.session_id === 'string' && rawInput.session_id.trim().length > 0) {
    parsed.session_id = rawInput.session_id.trim();
  } else if (typeof rawInput.session_id === 'number' && Number.isInteger(rawInput.session_id)) {
    parsed.session_id = String(rawInput.session_id);
  }
  if (typeof rawInput.timeout_ms === 'number' && Number.isFinite(rawInput.timeout_ms)) {
    const timeout = Math.floor(rawInput.timeout_ms);
    if (timeout > 0) parsed.timeout_ms = timeout;
  }
  return parsed;
}

function parseSessionId(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid session_id: ${raw}`);
  }
  return parsed;
}

function escapeShellArg(value: string): string {
  if (value.length === 0) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
