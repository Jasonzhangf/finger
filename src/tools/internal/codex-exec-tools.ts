import { InternalTool, ToolExecutionContext } from './types.js';
import {
  CodexExecSessionManager,
  ExecCommandToolOutput,
  type ExecCommandRuntimeInput,
  type WriteStdinRuntimeInput,
} from './codex-exec-session-manager.js';

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const DEFAULT_SHELL = '/bin/bash';
const DEFAULT_LOGIN = true;

interface ExecCommandInput {
  cmd: string;
  yield_time_ms: number;
  max_output_tokens: number;
  shell: string;
  login: boolean;
}

interface WriteStdinInput {
  session_id: number;
  chars: string;
  yield_time_ms: number;
  max_output_tokens: number;
}

const sessionManager = new CodexExecSessionManager();

export const execCommandTool: InternalTool<unknown, ExecCommandToolOutput> = {
  name: 'exec_command',
  description:
    'Execute shell commands on the local machine with streaming output. Use apply_patch for file modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The shell command to execute.' },
      yield_time_ms: { type: 'number', description: 'The maximum time in milliseconds to wait for output.' },
      max_output_tokens: { type: 'number', description: 'The maximum number of tokens to output.' },
      shell: { type: 'string', description: 'The shell to use. Defaults to "/bin/bash".' },
      login: { type: 'boolean', description: 'Whether to run the command as a login shell. Defaults to true.' },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ExecCommandToolOutput> => {
    const input = parseExecCommandInput(rawInput);
    const runtimeInput: ExecCommandRuntimeInput = {
      cmd: input.cmd,
      cwd: context.cwd,
      shell: input.shell,
      login: input.login,
      yieldTimeMs: input.yield_time_ms,
      maxOutputTokens: input.max_output_tokens,
    };
    return sessionManager.executeCommand(runtimeInput);
  },
};

export const writeStdinTool: InternalTool<unknown, ExecCommandToolOutput> = {
  name: 'write_stdin',
  description:
    "Write characters to an exec session's stdin and return stdout+stderr received within yield_time_ms.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'number', description: 'The ID of the exec_command session.' },
      chars: { type: 'string', description: 'The characters to write to stdin. Empty string means poll output.' },
      yield_time_ms: {
        type: 'number',
        description: 'The maximum time in milliseconds to wait for output after writing.',
      },
      max_output_tokens: { type: 'number', description: 'The maximum number of tokens to output.' },
    },
    required: ['session_id', 'chars'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown): Promise<ExecCommandToolOutput> => {
    const input = parseWriteStdinInput(rawInput);
    const runtimeInput: WriteStdinRuntimeInput = {
      sessionId: input.session_id,
      chars: input.chars,
      yieldTimeMs: input.yield_time_ms,
      maxOutputTokens: input.max_output_tokens,
    };
    return sessionManager.writeStdin(runtimeInput);
  },
};

function parseExecCommandInput(rawInput: unknown): ExecCommandInput {
  if (!isRecord(rawInput)) {
    throw new Error('exec_command input must be an object');
  }

  if (typeof rawInput.cmd !== 'string' || rawInput.cmd.trim().length === 0) {
    throw new Error('exec_command input.cmd must be a non-empty string');
  }

  return {
    cmd: rawInput.cmd,
    yield_time_ms: parseNumberWithDefault(rawInput.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS),
    max_output_tokens: parseNumberWithDefault(rawInput.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS),
    shell: parseStringWithDefault(rawInput.shell, DEFAULT_SHELL),
    login: typeof rawInput.login === 'boolean' ? rawInput.login : DEFAULT_LOGIN,
  };
}

function parseWriteStdinInput(rawInput: unknown): WriteStdinInput {
  if (!isRecord(rawInput)) {
    throw new Error('write_stdin input must be an object');
  }

  const sessionId = rawInput.session_id;
  if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId < 0) {
    throw new Error('write_stdin input.session_id must be a non-negative integer');
  }

  if (typeof rawInput.chars !== 'string') {
    throw new Error('write_stdin input.chars must be a string');
  }

  return {
    session_id: sessionId,
    chars: rawInput.chars,
    yield_time_ms: parseNumberWithDefault(rawInput.yield_time_ms, DEFAULT_WRITE_STDIN_YIELD_TIME_MS),
    max_output_tokens: parseNumberWithDefault(rawInput.max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS),
  };
}

function parseNumberWithDefault(raw: unknown, defaultValue: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return defaultValue;
  }
  const normalized = Math.floor(raw);
  if (normalized <= 0) {
    return defaultValue;
  }
  return normalized;
}

function parseStringWithDefault(raw: unknown, defaultValue: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return defaultValue;
  }
  return raw.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
