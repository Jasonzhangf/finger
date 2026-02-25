import { CliCapabilityDescriptor } from '../external/cli-capability-registry.js';
import { InternalTool, ToolExecutionContext } from './types.js';
import { runSpawnCommand } from './spawn-runner.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CliCapabilityToolInput {
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface CliCapabilityToolOutput {
  capabilityId: string;
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

export function createCliCapabilityTool(
  descriptor: CliCapabilityDescriptor,
): InternalTool<unknown, CliCapabilityToolOutput> {
  const toolName = `capability.${descriptor.id}`;
  return {
    name: toolName,
    description: descriptor.runtimeDescription ?? `${descriptor.description} (CLI: ${descriptor.command})`,
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<CliCapabilityToolOutput> => {
      const input = parseCapabilityToolInput(rawInput);
      const commandArray = [
        descriptor.command,
        ...(descriptor.defaultArgs ?? []),
        ...(input.args ?? []),
      ];
      const cwd = input.cwd ?? context.cwd;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const commandDisplay = commandArray.join(' ');

      const execution = await runSpawnCommand({
        commandArray,
        cwd,
        timeoutMs,
        env: input.env,
      });

      return {
        capabilityId: descriptor.id,
        ok: execution.exitCode === 0 && !execution.timedOut,
        exitCode: execution.exitCode,
        signal: execution.signal,
        stdout: execution.stdout,
        stderr: execution.stderr,
        command: commandDisplay,
        commandArray,
        cwd,
        timedOut: execution.timedOut,
        durationMs: execution.durationMs,
      };
    },
  };
}

function parseCapabilityToolInput(input: unknown): CliCapabilityToolInput {
  if (!isRecord(input)) {
    if (input === undefined || input === null) {
      return {};
    }
    throw new Error('capability tool input must be an object');
  }

  const parsed: CliCapabilityToolInput = {};

  if (Array.isArray(input.args)) {
    const args = input.args.filter((item): item is string => typeof item === 'string');
    if (args.length !== input.args.length) {
      throw new Error('capability tool input.args must be string[]');
    }
    parsed.args = args;
  }

  if (typeof input.cwd === 'string' && input.cwd.trim().length > 0) {
    parsed.cwd = input.cwd;
  }

  if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
    parsed.timeoutMs = Math.floor(input.timeoutMs);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
