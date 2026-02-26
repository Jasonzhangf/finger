import { InternalTool, ToolExecutionContext } from './types.js';
import { runSpawnCommand } from './spawn-runner.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ShellExecInput {
  command: string | string[];
  cwd?: string;
  timeoutMs?: number;
  shellPath?: string;
  env?: Record<string, string>;
}

export interface ShellExecOutput {
  ok: boolean;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  command: string;
  commandArray: string[];
  cwd: string;
  timedOut: boolean;
  durationMs: number;
}

interface ShellInvocation {
  commandArray: string[];
  displayCommand: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseShellExecInput(input: unknown): ShellExecInput {
  if (!isRecord(input)) {
    throw new Error('shell.exec input must be an object');
  }

  const command = input.command;
  if (typeof command !== 'string' && !Array.isArray(command)) {
    throw new Error('shell.exec input.command must be string or string[]');
  }

  if (Array.isArray(command) && command.some((item) => typeof item !== 'string')) {
    throw new Error('shell.exec input.command array must only contain strings');
  }

  const parsed: ShellExecInput = {
    command,
  };

  if (typeof input.cwd === 'string' && input.cwd.trim().length > 0) {
    parsed.cwd = input.cwd;
  }

  if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(input.timeoutMs);
  }

  if (typeof input.shellPath === 'string' && input.shellPath.trim().length > 0) {
    parsed.shellPath = input.shellPath;
  }

  if (isRecord(input.env)) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string') {
        env[key] = value;
      }
    }
    parsed.env = env;
  }

  return parsed;
}

function normalizeInvocation(input: ShellExecInput): ShellInvocation {
  const shellProgram = input.shellPath ?? process.env.SHELL ?? '/bin/zsh';

  if (typeof input.command === 'string') {
    const command = input.command.trim();
    if (command.length === 0) {
      throw new Error('shell.exec command cannot be empty');
    }
    return {
      commandArray: [shellProgram, '-lc', command],
      displayCommand: command,
    };
  }

  if (input.command.length === 0) {
    throw new Error('shell.exec command array cannot be empty');
  }

  const displayCommand = input.command.join(' ');
  if (shouldRunArrayWithShell(input.command)) {
    return {
      commandArray: [shellProgram, '-lc', displayCommand],
      displayCommand,
    };
  }

  return {
    commandArray: input.command,
    displayCommand,
  };
}

function shouldRunArrayWithShell(command: string[]): boolean {
  if (command.length === 1) {
    const single = command[0].trim();
    return /[\s;&|><]/.test(single);
  }

  const shellTokens = new Set(['&&', '||', '|', ';', '>', '>>', '<', '2>', '2>>']);
  if (command.some((token) => shellTokens.has(token.trim()))) {
    return true;
  }

  const first = command[0].trim().toLowerCase();
  const shellBuiltins = new Set([
    'cd',
    'export',
    'unset',
    'alias',
    'unalias',
    'source',
    '.',
    'set',
  ]);
  return shellBuiltins.has(first);
}

export const shellExecTool: InternalTool<unknown, ShellExecOutput> = {
  name: 'shell.exec',
  description: 'Execute shell command locally and return stdout/stderr/exit code',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      cwd: { type: 'string' },
      timeoutMs: { type: 'number' },
      shellPath: { type: 'string' },
      env: { type: 'object', additionalProperties: { type: 'string' } },
    },
    required: ['command'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ShellExecOutput> => {
    const input = parseShellExecInput(rawInput);
    const invocation = normalizeInvocation(input);
    const cwd = input.cwd ?? context.cwd;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const execution = await runSpawnCommand({
      commandArray: invocation.commandArray,
      cwd,
      timeoutMs,
      env: input.env,
    });

    return {
      ok: execution.exitCode === 0 && !execution.timedOut,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdout: execution.stdout,
      stderr: execution.stderr,
      command: invocation.displayCommand,
      commandArray: invocation.commandArray,
      cwd,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
    };
  },
};
