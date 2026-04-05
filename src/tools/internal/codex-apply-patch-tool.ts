import { existsSync, accessSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { InternalTool, ToolExecutionContext } from './types.js';

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

interface PatchOpAdd {
  kind: 'add';
  filePath: string;
  lines: string[];
}

interface PatchOpDelete {
  kind: 'delete';
  filePath: string;
}

interface PatchOpUpdate {
  kind: 'update';
  filePath: string;
  moveTo?: string;
  bodyLines: string[];
}

type PatchOp = PatchOpAdd | PatchOpDelete | PatchOpUpdate;

export const applyPatchTool: InternalTool<unknown, ApplyPatchOutput> = {
  name: 'apply_patch',
  executionModel: 'execution',
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
    const timeoutMs = typeof input.timeout_ms === 'number' && input.timeout_ms > 0
      ? Math.floor(input.timeout_ms)
      : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const timedOut = false;
    const ops = parseApplyPatchOps(input.input);
    applyPatchOps(ops, context.cwd);
    const durationMs = Date.now() - startedAt;
    const summary = formatPatchSummary(ops);

    return {
      ok: !timedOut && durationMs <= timeoutMs,
      exitCode: 0,
      signal: null,
      stdout: summary,
      stderr: '',
      command: 'internal_apply_patch',
      commandArray: ['internal_apply_patch'],
      cwd: context.cwd,
      timedOut,
      durationMs,
    };
  },
};

export function resolveApplyPatchCommand(defaultCwd: string): ApplyPatchCommandDescriptor | null {
  const envBin = process.env.FINGER_CODEX_APPLY_PATCH_BIN;
  if (envBin && envBin.trim().length > 0) {
    const resolved = envBin.trim();
    if (isExecutableFile(resolved) || isCommandAvailable(resolved)) {
      return {
        commandArrayPrefix: [resolved],
        cwd: defaultCwd,
      };
    }
  }

  if (isCommandAvailable('apply_patch')) {
    return {
      commandArrayPrefix: ['apply_patch'],
      cwd: defaultCwd,
    };
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

function parseApplyPatchOps(input: string): PatchOp[] {
  const normalized = input.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '*** Begin Patch') {
    throw new Error('Invalid apply_patch payload: missing "*** Begin Patch"');
  }
  const endIndex = lines.findIndex((line) => line.trim() === '*** End Patch');
  if (endIndex < 0) {
    throw new Error('Invalid apply_patch payload: missing "*** End Patch"');
  }
  const ops: PatchOp[] = [];
  let i = 1;
  while (i < endIndex) {
    const line = lines[i];
    if (!line || line.trim().length === 0) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim();
      if (!filePath) throw new Error('Invalid apply_patch payload: missing add file path');
      i += 1;
      const content: string[] = [];
      while (i < endIndex && !isPatchHeader(lines[i])) {
        const body = lines[i];
        if (body === '*** End of File') {
          i += 1;
          continue;
        }
        if (!body.startsWith('+')) {
          throw new Error(`Invalid add-file line (must start with '+'): ${body}`);
        }
        content.push(body.slice(1));
        i += 1;
      }
      ops.push({ kind: 'add', filePath, lines: content });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const filePath = line.slice('*** Delete File: '.length).trim();
      if (!filePath) throw new Error('Invalid apply_patch payload: missing delete file path');
      ops.push({ kind: 'delete', filePath });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim();
      if (!filePath) throw new Error('Invalid apply_patch payload: missing update file path');
      i += 1;
      let moveTo: string | undefined;
      if (i < endIndex && lines[i].startsWith('*** Move to: ')) {
        const moved = lines[i].slice('*** Move to: '.length).trim();
        if (!moved) throw new Error('Invalid apply_patch payload: missing move target path');
        moveTo = moved;
        i += 1;
      }
      const bodyLines: string[] = [];
      while (i < endIndex && !isPatchHeader(lines[i])) {
        const body = lines[i];
        if (body === '*** End of File') {
          i += 1;
          continue;
        }
        if (body.startsWith('@@') || body.startsWith(' ') || body.startsWith('+') || body.startsWith('-')) {
          bodyLines.push(body);
          i += 1;
          continue;
        }
        throw new Error(`Invalid update-file line: ${body}`);
      }
      ops.push({ kind: 'update', filePath, moveTo, bodyLines });
      continue;
    }
    throw new Error(`Invalid apply_patch payload header: ${line}`);
  }
  if (ops.length === 0) {
    throw new Error('Invalid apply_patch payload: no operations');
  }
  return ops;
}

function isPatchHeader(line: string): boolean {
  return line.startsWith('*** Add File: ')
    || line.startsWith('*** Delete File: ')
    || line.startsWith('*** Update File: ')
    || line.trim() === '*** End Patch';
}

function applyPatchOps(ops: PatchOp[], cwd: string): void {
  for (const op of ops) {
    if (op.kind === 'add') {
      const target = resolvePatchPath(cwd, op.filePath);
      if (existsSync(target)) {
        throw new Error(`apply_patch add failed: file already exists: ${op.filePath}`);
      }
      ensureParentDir(target);
      const next = op.lines.length > 0 ? `${op.lines.join('\n')}\n` : '';
      writeFileSync(target, next, 'utf-8');
      continue;
    }
    if (op.kind === 'delete') {
      const target = resolvePatchPath(cwd, op.filePath);
      if (!existsSync(target)) {
        throw new Error(`apply_patch delete failed: file not found: ${op.filePath}`);
      }
      rmSync(target);
      continue;
    }

    const sourcePath = resolvePatchPath(cwd, op.filePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`apply_patch update failed: file not found: ${op.filePath}`);
    }
    const original = readFileSync(sourcePath, 'utf-8');
    const hadTrailingNewline = original.endsWith('\n');
    let lines = splitFileLines(original);
    const blocks = parseUpdateBlocks(op.bodyLines);
    let searchStart = 0;
    for (const block of blocks) {
      const oldSeq = block.filter((entry) => entry.kind !== '+').map((entry) => entry.text);
      const newSeq = block.filter((entry) => entry.kind !== '-').map((entry) => entry.text);
      let idx = findSubsequence(lines, oldSeq, searchStart);
      if (idx < 0 && searchStart > 0) {
        idx = findSubsequence(lines, oldSeq, 0);
      }
      if (idx < 0) {
        throw new Error(`apply_patch update failed: hunk context not found in ${op.filePath}`);
      }
      lines.splice(idx, oldSeq.length, ...newSeq);
      searchStart = idx + newSeq.length;
    }
    let nextContent = lines.join('\n');
    if (lines.length > 0 && hadTrailingNewline) {
      nextContent += '\n';
    }
    writeFileSync(sourcePath, nextContent, 'utf-8');
    if (op.moveTo && op.moveTo.trim().length > 0) {
      const movedTo = resolvePatchPath(cwd, op.moveTo);
      ensureParentDir(movedTo);
      if (existsSync(movedTo)) {
        throw new Error(`apply_patch move failed: target exists: ${op.moveTo}`);
      }
      renameSync(sourcePath, movedTo);
    }
  }
}

function resolvePatchPath(cwd: string, filePath: string): string {
  const resolved = path.resolve(cwd, filePath);
  return resolved;
}

function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
}

function splitFileLines(content: string): string[] {
  if (content.length === 0) return [];
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (trimmed.length === 0) return [];
  return trimmed.split('\n');
}

function parseUpdateBlocks(
  bodyLines: string[],
): Array<Array<{ kind: ' ' | '+' | '-'; text: string }>> {
  const blocks: Array<Array<{ kind: ' ' | '+' | '-'; text: string }>> = [];
  let current: Array<{ kind: ' ' | '+' | '-'; text: string }> | null = null;
  for (const line of bodyLines) {
    if (line.startsWith('@@')) {
      if (current && current.length > 0) blocks.push(current);
      current = [];
      continue;
    }
    const prefix = line[0] as ' ' | '+' | '-';
    if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
      continue;
    }
    if (!current) current = [];
    current.push({ kind: prefix, text: line.slice(1) });
  }
  if (current && current.length > 0) blocks.push(current);
  return blocks;
}

function findSubsequence(haystack: string[], needle: string[], startIndex: number): number {
  if (needle.length === 0) return Math.min(Math.max(startIndex, 0), haystack.length);
  if (needle.length > haystack.length) return -1;
  for (let i = Math.max(0, startIndex); i <= haystack.length - needle.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function formatPatchSummary(ops: PatchOp[]): string {
  const rows: string[] = [];
  for (const op of ops) {
    if (op.kind === 'add') rows.push(`Added ${op.filePath}`);
    else if (op.kind === 'delete') rows.push(`Deleted ${op.filePath}`);
    else if (op.moveTo) rows.push(`Updated ${op.filePath} -> ${op.moveTo}`);
    else rows.push(`Updated ${op.filePath}`);
  }
  return rows.join('\n');
}

function isCommandAvailable(command: string): boolean {
  if (path.isAbsolute(command)) {
    return isExecutableFile(command);
  }
  const result = spawnSync('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
