import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchTool } from '../../../../src/tools/internal/codex-patch-tool.js';

const TEST_CONTEXT_BASE = {
  invocationId: 'patch-test',
  timestamp: new Date().toISOString(),
};

describe('codex patch tool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('applies delete-file patch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-delete-'));
    try {
      const file = path.join(dir, 'legacy.txt');
      writeFileSync(file, 'legacy\n', 'utf-8');

      const patch = [
        '*** Begin Patch',
        '*** Delete File: legacy.txt',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        { ...TEST_CONTEXT_BASE, cwd: dir },
      );

      expect(result.ok).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(result.stdout).toBe('Deleted legacy.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies move via update-file patch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-move-'));
    try {
      const source = path.join(dir, 'src.txt');
      const moved = path.join(dir, 'nested/dest.txt');
      writeFileSync(source, 'line1\nline2\n', 'utf-8');

      const patch = [
        '*** Begin Patch',
        '*** Update File: src.txt',
        '*** Move to: nested/dest.txt',
        '@@',
        ' line1',
        '-line2',
        '+line2-moved',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        { ...TEST_CONTEXT_BASE, cwd: dir },
      );

      expect(result.ok).toBe(true);
      expect(existsSync(source)).toBe(false);
      expect(readFileSync(moved, 'utf-8')).toBe('line1\nline2-moved\n');
      expect(result.stdout).toBe('Updated src.txt -> nested/dest.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects patch paths that escape cwd', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-escape-'));
    const escaped = path.resolve(dir, '../escape.txt');
    try {
      const patch = [
        '*** Begin Patch',
        '*** Add File: ../escape.txt',
        '+escaped',
        '*** End Patch',
      ].join('\n');

      await expect(
        patchTool.execute({ patch }, { ...TEST_CONTEXT_BASE, cwd: dir }),
      ).rejects.toThrow('patch path escapes cwd: ../escape.txt');
      expect(existsSync(escaped)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(escaped, { force: true });
    }
  });

  it('plans all operations before commit to avoid partial success', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-atomic-'));
    try {
      const created = path.join(dir, 'created.txt');
      const patch = [
        '*** Begin Patch',
        '*** Add File: created.txt',
        '+created',
        '*** Update File: missing.txt',
        '@@',
        '+boom',
        '*** End Patch',
      ].join('\n');

      await expect(
        patchTool.execute({ patch }, { ...TEST_CONTEXT_BASE, cwd: dir }),
      ).rejects.toThrow('patch update failed: file not found: missing.txt');
      expect(existsSync(created)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores no-newline marker and preserves file without trailing newline', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-nonewline-'));
    try {
      const file = path.join(dir, 'plain.txt');
      writeFileSync(file, 'line1\nline2', 'utf-8');

      const patch = [
        '*** Begin Patch',
        '*** Update File: plain.txt',
        '@@',
        ' line1',
        '-line2',
        '+line2-updated',
        '\\ No newline at end of file',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch },
        { ...TEST_CONTEXT_BASE, cwd: dir },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('line1\nline2-updated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not mark result failed when duration exceeds advisory timeout', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000).mockReturnValueOnce(6_000);

    const dir = mkdtempSync(path.join(tmpdir(), 'finger-patch-timeout-'));
    try {
      const patch = [
        '*** Begin Patch',
        '*** Add File: timeout.txt',
        '+slow but committed',
        '*** End Patch',
      ].join('\n');

      const result = await patchTool.execute(
        { patch, timeout_ms: 1 },
        { ...TEST_CONTEXT_BASE, cwd: dir },
      );

      expect(result.ok).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.durationMs).toBe(5_000);
      expect(readFileSync(path.join(dir, 'timeout.txt'), 'utf-8')).toBe('slow but committed\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
