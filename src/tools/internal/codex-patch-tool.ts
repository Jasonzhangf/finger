import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { InternalTool, ToolExecutionContext } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

interface PatchInput {
  patch: string;
  timeout_ms?: number;
}

export interface PatchOutput {
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
  repairedLooseContent?: boolean;
}

type PatchOp = PatchOpAdd | PatchOpDelete | PatchOpUpdate;

export const patchTool: InternalTool<unknown, PatchOutput> = {
  name: 'patch',
  executionModel: 'execution',
  description:
    'Use the patch tool to edit files. Do not call patch through exec_command for file modifications.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Patch text in Finger patch format.' },
      timeout_ms: { type: 'number' },
    },
    required: ['patch'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown, context: ToolExecutionContext): Promise<PatchOutput> => {
    const input = parsePatchInput(rawInput);
    const timeoutMs = typeof input.timeout_ms === 'number' && input.timeout_ms > 0
      ? Math.floor(input.timeout_ms)
      : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const timedOut = false;
    const ops = parsePatchOps(input.patch);
    applyPatchOps(ops, context.cwd);
    const durationMs = Date.now() - startedAt;
    const summary = formatPatchSummary(ops);

    return {
      ok: !timedOut && durationMs <= timeoutMs,
      exitCode: 0,
      signal: null,
      stdout: summary,
      stderr: '',
      command: 'internal_patch',
      commandArray: ['internal_patch'],
      cwd: context.cwd,
      timedOut,
      durationMs,
    };
  },
};

function parsePatchInput(rawInput: unknown): PatchInput {
  if (!isRecord(rawInput)) {
    throw new Error('patch input must be an object');
  }

  if (typeof rawInput.patch !== 'string' || rawInput.patch.trim().length === 0) {
    throw new Error('patch input.patch must be a non-empty string');
  }

  const parsed: PatchInput = {
    patch: rawInput.patch,
  };

  if (typeof rawInput.timeout_ms === 'number' && Number.isFinite(rawInput.timeout_ms)) {
    parsed.timeout_ms = rawInput.timeout_ms;
  }

  return parsed;
}

function parsePatchOps(input: string): PatchOp[] {
  const normalized = input.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '*** Begin Patch') {
    throw new Error('Invalid patch payload: missing "*** Begin Patch"');
  }
  const endIndex = lines.findIndex((line) => line.trim() === '*** End Patch');
  if (endIndex < 0) {
    throw new Error('Invalid patch payload: missing "*** End Patch"');
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
      if (!filePath) throw new Error('Invalid patch payload: missing add file path');
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
      if (!filePath) throw new Error('Invalid patch payload: missing delete file path');
      ops.push({ kind: 'delete', filePath });
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim();
      if (!filePath) throw new Error('Invalid patch payload: missing update file path');
      i += 1;
      let moveTo: string | undefined;
      if (i < endIndex && lines[i].startsWith('*** Move to: ')) {
        const moved = lines[i].slice('*** Move to: '.length).trim();
        if (!moved) throw new Error('Invalid patch payload: missing move target path');
        moveTo = moved;
        i += 1;
      }
      const bodyLines: string[] = [];
      let sawHunkHeader = false;
      let repairedLooseContent = false;
      while (i < endIndex && !isPatchHeader(lines[i])) {
        const body = lines[i];
        if (body === '*** End of File') {
          i += 1;
          continue;
        }
        if (body.startsWith('@@')) {
          sawHunkHeader = true;
          bodyLines.push(body);
          i += 1;
          continue;
        }
        if (repairedLooseContent) {
          bodyLines.push(`+${body}`);
          i += 1;
          continue;
        }
        if (body.startsWith(' ') || body.startsWith('+') || body.startsWith('-')) {
          bodyLines.push(body);
          i += 1;
          continue;
        }

        repairedLooseContent = true;
        if (!sawHunkHeader) {
          bodyLines.push('@@');
          sawHunkHeader = true;
        }
        bodyLines.push(`+${body}`);
        i += 1;
      }
      ops.push({ kind: 'update', filePath, moveTo, bodyLines, repairedLooseContent });
      continue;
    }
    throw new Error(`Invalid patch payload header: ${line}`);
  }
  if (ops.length === 0) {
    throw new Error('Invalid patch payload: no operations');
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
        throw new Error(`patch add failed: file already exists: ${op.filePath}`);
      }
      ensureParentDir(target);
      const next = op.lines.length > 0 ? `${op.lines.join('\n')}\n` : '';
      writeFileSync(target, next, 'utf-8');
      continue;
    }
    if (op.kind === 'delete') {
      const target = resolvePatchPath(cwd, op.filePath);
      if (!existsSync(target)) {
        throw new Error(`patch delete failed: file not found: ${op.filePath}`);
      }
      rmSync(target);
      continue;
    }

    const sourcePath = resolvePatchPath(cwd, op.filePath);
    if (!existsSync(sourcePath)) {
      throw new Error(`patch update failed: file not found: ${op.filePath}`);
    }
    const original = readFileSync(sourcePath, 'utf-8');
    const hadTrailingNewline = original.endsWith('\n');
    let lines = splitFileLines(original);
    const blocks = parseUpdateBlocks(op.bodyLines);
    let searchStart = 0;
    const shouldReplaceWholeFile =
      op.repairedLooseContent === true
      && blocks.length > 0
      && blocks.every((block) => block.every((entry) => entry.kind !== '-'))
      && blocks.every((block) => block.filter((entry) => entry.kind !== '+').length === 0);
    if (shouldReplaceWholeFile) {
      lines = blocks.flatMap((block) => block.filter((entry) => entry.kind === '+').map((entry) => entry.text));
    }
    for (const block of blocks) {
      if (shouldReplaceWholeFile) break;
      const oldSeq = block.filter((entry) => entry.kind !== '+').map((entry) => entry.text);
      const newSeq = block.filter((entry) => entry.kind !== '-').map((entry) => entry.text);
      let idx = findSubsequence(lines, oldSeq, searchStart);
      if (idx < 0 && searchStart > 0) {
        idx = findSubsequence(lines, oldSeq, 0);
      }
      if (idx < 0) {
        throw new Error(`patch update failed: hunk context not found in ${op.filePath}`);
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
        throw new Error(`patch move failed: target exists: ${op.moveTo}`);
      }
      renameSync(sourcePath, movedTo);
    }
  }
}

function resolvePatchPath(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath);
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
