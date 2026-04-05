import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseApplyPatchCliArgs, runApplyPatchCli } from '../../../src/cli/apply-patch.js';

describe('apply_patch CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses cli args with cwd and timeout', () => {
    const parsed = parseApplyPatchCliArgs([
      '--cwd',
      './tmp',
      '--timeout-ms',
      '1500',
      '*** Begin Patch\n*** Add File: a.txt\n+ok\n*** End Patch',
    ]);

    expect(parsed.cwd).toBe(path.resolve('./tmp'));
    expect(parsed.timeoutMs).toBe(1500);
    expect(parsed.patchText).toContain('*** Begin Patch');
  });

  it('applies patch from argument text', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-apply-patch-cli-arg-'));
    try {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const patch = [
        '*** Begin Patch',
        '*** Add File: arg.txt',
        '+from-arg',
        '*** End Patch',
      ].join('\n');

      const code = await runApplyPatchCli(['--cwd', dir, patch]);

      expect(code).toBe(0);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(readFileSync(path.join(dir, 'arg.txt'), 'utf-8')).toBe('from-arg\n');
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies patch from stdin text when no patch arg is provided', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-apply-patch-cli-stdin-'));
    try {
      writeFileSync(path.join(dir, 'note.txt'), 'line1\nline2\n', 'utf-8');
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const patch = [
        '*** Begin Patch',
        '*** Update File: note.txt',
        '@@',
        ' line1',
        '-line2',
        '+line2-updated',
        '*** End Patch',
      ].join('\n');

      const code = await runApplyPatchCli(['--cwd', dir], patch);

      expect(code).toBe(0);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(readFileSync(path.join(dir, 'note.txt'), 'utf-8')).toBe('line1\nline2-updated\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns error when patch text is missing', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runApplyPatchCli([]);

    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });
});
