import { InternalTool, ToolExecutionContext } from './types.js';
import { runSpawnCommand } from './spawn-runner.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface CodexShellInput {
  command: string[];
  workdir?: string;
  timeout_ms?: number;
  with_escalated_permissions?: boolean;
  justification?: string;
}

export interface CodexShellOutput {
  ok: boolean;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  command: string[];
  workdir: string;
  withEscalatedPermissions: boolean;
  justification?: string;
}

export const codexShellTool: InternalTool<unknown, CodexShellOutput> = {
  name: 'shell',
  description: 'Runs a shell command and returns its output.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'array', items: { type: 'string' }, description: 'The command to execute' },
      workdir: { type: 'string', description: 'The working directory to execute the command in' },
      timeout_ms: { type: 'number', description: 'The timeout for the command in milliseconds' },
      with_escalated_permissions: {
        type: 'boolean',
        description: 'Whether to request escalated permissions.',
      },
      justification: {
        type: 'string',
        description: 'Only set if with_escalated_permissions is true.',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<CodexShellOutput> => {
    const input = parseShellInput(rawInput);
    const workdir = input.workdir ?? context.cwd;
    const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const execution = await runSpawnCommand({
      commandArray: input.command,
      cwd: workdir,
      timeoutMs,
    });

    return {
      ok: execution.exitCode === 0 && !execution.timedOut,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdout: execution.stdout,
      stderr: execution.stderr,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
      command: input.command,
      workdir,
      withEscalatedPermissions: input.with_escalated_permissions ?? false,
      justification: input.justification,
    };
  },
};

function parseShellInput(rawInput: unknown): CodexShellInput {
  if (!isRecord(rawInput)) {
    throw new Error('shell input must be an object');
  }
  if (!Array.isArray(rawInput.command) || rawInput.command.length === 0) {
    throw new Error('shell input.command must be a non-empty string[]');
  }
  const command = rawInput.command.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (command.length !== rawInput.command.length) {
    throw new Error('shell input.command must contain only non-empty strings');
  }

  const parsed: CodexShellInput = { command };
  if (typeof rawInput.workdir === 'string' && rawInput.workdir.trim().length > 0) {
    parsed.workdir = rawInput.workdir.trim();
  }
  if (typeof rawInput.timeout_ms === 'number' && Number.isFinite(rawInput.timeout_ms)) {
    const timeout = Math.floor(rawInput.timeout_ms);
    if (timeout > 0) parsed.timeout_ms = timeout;
  }
  if (typeof rawInput.with_escalated_permissions === 'boolean') {
    parsed.with_escalated_permissions = rawInput.with_escalated_permissions;
  }
  if (typeof rawInput.justification === 'string' && rawInput.justification.trim().length > 0) {
    parsed.justification = rawInput.justification.trim();
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
