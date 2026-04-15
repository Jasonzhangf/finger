import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { patchTool } from '../../../../src/tools/internal/codex-patch-tool.js';

const TEST_CONTEXT_BASE = {
  invocationId: 'patch-test',
  timestamp: new Date().toISOString(),
};

describe('codex patch tool', () => {
  it('exposes canonical tool name as patch', () => {
    expect(patchTool.name).toBe('patch');
  });

  it('rejects non-object input payloads', async () => {
    await expect(patchTool.execute('*** Begin Patch', {
      ...TEST_CONTEXT_BASE,
      cwd: process.cwd(),
    })).rejects.toThrow('patch input must be an object');
  });

  it('applies add-file patch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-'));
    try {
      const patch = [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+hello from patch',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        {
          ...TEST_CONTEXT_BASE,
          cwd: dir,
        },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(dir, 'hello.txt'), 'utf-8')).toBe('hello from patch\n');
      expect(result.stdout).toBe('Added hello.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies update-file patch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-update-'));
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'line1\nline2\nline3\n', 'utf-8');

      const patch = [
        '*** Begin Patch',
        '*** Update File: note.txt',
        '@@',
        ' line1',
        '-line2',
        '+line2-updated',
        ' line3',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        {
          ...TEST_CONTEXT_BASE,
          cwd: dir,
        },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('line1\nline2-updated\nline3\n');
      expect(result.stdout).toBe('Updated note.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repairs loose update-file patch shape and replaces file content', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-loose-update-'));
    try {
      const file = path.join(dir, 'daily.md');
      writeFileSync(file, 'old-line-1\nold-line-2\n', 'utf-8');

      const patch = [
        '*** Begin Patch',
        '*** Update File: daily.md',
        '@@',
        '# Finger 每日系统复盘 - 2026-04-06',
        '',
        '- 任务一',
        '- 任务二',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        {
          ...TEST_CONTEXT_BASE,
          cwd: dir,
        },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('# Finger 每日系统复盘 - 2026-04-06\n\n- 任务一\n- 任务二\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
