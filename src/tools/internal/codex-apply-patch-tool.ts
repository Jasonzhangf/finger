import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { InternalTool, ToolExecutionContext } from './types.js';
import { runSpawnCommand } from './spawn-runner.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface ApplyPatchInput {
  input: string;
  timeout_ms?: number;
}

export interface ApplyPatchOutput {
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

interface ApplyPatchCommandDescriptor {
  commandArrayPrefix: string[];
  cwd: string;
}

export const applyPatchTool: InternalTool<unknown, ApplyPatchOutput> = {
  name: 'apply_patch',
  description:
    'Use the apply_patch tool to edit files. Do not call apply_patch through exec_command for file modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The entire contents of the apply_patch command' },
      timeout_ms: { type: 'number' },
    },
    required: ['input'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<ApplyPatchOutput> => {
    const input = parseApplyPatchInput(rawInput);
    const commandDescriptor = resolveApplyPatchCommand(context.cwd);
    if (!commandDescriptor) {
      throw new Error(
        'apply_patch command is not available. Set FINGER_CODEX_APPLY_PATCH_BIN or install apply_patch in PATH.',
      );
    }

    const commandArray = [...commandDescriptor.commandArrayPrefix, input.input];
    const timeoutMs = typeof input.timeout_ms === 'number' && input.timeout_ms > 0
      ? Math.floor(input.timeout_ms)
      : DEFAULT_TIMEOUT_MS;

    const execution = await runSpawnCommand({
      commandArray,
      cwd: commandDescriptor.cwd,
      timeoutMs,
    });

    return {
      ok: execution.exitCode === 0 && !execution.timedOut,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdout: execution.stdout,
      stderr: execution.stderr,
      command: commandArray.join(' '),
      commandArray,
      cwd: commandDescriptor.cwd,
      timedOut: execution.timedOut,
      durationMs: execution.durationMs,
    };
  },
};

export function resolveApplyPatchCommand(defaultCwd: string): ApplyPatchCommandDescriptor | null {
  const envBin = process.env.FINGER_CODEX_APPLY_PATCH_BIN;
  if (envBin && envBin.trim().length > 0) {
    return {
      commandArrayPrefix: [envBin.trim()],
      cwd: defaultCwd,
    };
  }

  if (isCommandAvailable('apply_patch')) {
    return {
      commandArrayPrefix: ['apply_patch'],
      cwd: defaultCwd,
    };
  }

  if (isCommandAvailable('cargo')) {
    const codexSourceDir = resolveDefaultCodexSourceDir();
    if (existsSync(path.join(codexSourceDir, 'Cargo.toml'))) {
      return {
        commandArrayPrefix: ['cargo', 'run', '-q', '-p', 'apply_patch', '--'],
        cwd: codexSourceDir,
      };
    }
  }

  return null;
}

function parseApplyPatchInput(rawInput: unknown): ApplyPatchInput {
  if (!isRecord(rawInput)) {
    throw new Error('apply_patch input must be an object');
  }

  if (typeof rawInput.input !== 'string' || rawInput.input.trim().length === 0) {
    throw new Error('apply_patch input.input must be a non-empty string');
  }

  const parsed: ApplyPatchInput = {
    input: rawInput.input,
  };

  if (typeof rawInput.timeout_ms === 'number' && Number.isFinite(rawInput.timeout_ms)) {
    parsed.timeout_ms = rawInput.timeout_ms;
  }

  return parsed;
}

function resolveDefaultCodexSourceDir(): string {
  const envDir = process.env.FINGER_CODEX_SOURCE_DIR;
  if (envDir && envDir.trim().length > 0) {
    return envDir.trim();
  }
  return path.join(homedir(), 'Documents', 'code', 'codex', 'codex-rs');
}

function isCommandAvailable(command: string): boolean {
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
