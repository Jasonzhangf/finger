#!/usr/bin/env node

import { readFileSync, realpathSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { applyPatchTool } from '../tools/internal/codex-apply-patch-tool.js';
import { createToolExecutionContext } from '../tools/internal/types.js';

export interface ApplyPatchCliOptions {
  cwd: string;
  timeoutMs?: number;
  patchText?: string;
  help: boolean;
}

export function parseApplyPatchCliArgs(argv: string[]): ApplyPatchCliOptions {
  const options: ApplyPatchCliOptions = {
    cwd: process.cwd(),
    help: false,
  };
  const patchParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--cwd') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --cwd');
      options.cwd = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      const next = argv[i + 1];
      if (!next) throw new Error('Missing value for --timeout-ms');
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${next}`);
      }
      options.timeoutMs = parsed;
      i += 1;
      continue;
    }
    patchParts.push(arg);
  }

  if (patchParts.length > 0) {
    options.patchText = patchParts.join(' ');
  }
  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: apply_patch [options] "<patch>"',
      '',
      'Options:',
      '  --cwd <path>         Apply patch relative to this directory (default: current cwd)',
      '  --timeout-ms <ms>    Timeout passed to internal apply_patch tool',
      '  -h, --help           Show this help',
      '',
      'You can also pipe patch text through stdin when no "<patch>" argument is provided.',
      '',
    ].join('\n'),
  );
}

function readPatchFromStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export async function runApplyPatchCli(
  argv: string[],
  stdinText?: string,
): Promise<number> {
  let options: ApplyPatchCliOptions;
  try {
    options = parseApplyPatchCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.help) {
    printUsage();
    return 0;
  }

  const patchText = options.patchText
    ?? (typeof stdinText === 'string' ? stdinText : readPatchFromStdin());
  if (!patchText || patchText.trim().length === 0) {
    process.stderr.write('apply_patch: patch text is required (argument or stdin)\n');
    return 2;
  }

  try {
    const result = await applyPatchTool.execute(
      {
        input: patchText,
        ...(typeof options.timeoutMs === 'number' ? { timeout_ms: options.timeoutMs } : {}),
      },
      createToolExecutionContext({ cwd: options.cwd }),
    );
    if (result.stdout && result.stdout.trim().length > 0) {
      process.stdout.write(`${result.stdout.trim()}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const thisFile = fileURLToPath(import.meta.url);
  try {
    const resolvedEntry = realpathSync(entry);
    const resolvedThisFile = realpathSync(thisFile);
    return path.resolve(resolvedEntry) === path.resolve(resolvedThisFile);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  runApplyPatchCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
