import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPatchTool, resolveApplyPatchCommand } from '../../../../src/tools/internal/codex-apply-patch-tool.js';

const TEST_CONTEXT_BASE = {
  invocationId: 'apply-patch-test',
  timestamp: new Date().toISOString(),
};

describe('codex apply_patch tool', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('resolves command from env override first', () => {
    process.env.FINGER_CODEX_APPLY_PATCH_BIN = '/tmp/custom-apply-patch';
    const resolved = resolveApplyPatchCommand(process.cwd());
    expect(resolved).not.toBeNull();
    expect(resolved?.commandArrayPrefix[0]).toBe('/tmp/custom-apply-patch');
  });

  it('applies add-file patch when apply_patch command is available', async () => {
    const resolved = resolveApplyPatchCommand(process.cwd());
    if (!resolved) {
      expect(true).toBe(true);
      return;
    }

    const dir = mkdtempSync(path.join(tmpdir(), 'finger-apply-patch-'));
    try {
      const patch = [
        '*** Begin Patch',
        '*** Add File: hello.txt',
        '+hello from patch',
        '*** End Patch',
      ].join('\n');

      const result = await applyPatchTool.execute(
        { input: patch },
        {
          ...TEST_CONTEXT_BASE,
          cwd: dir,
        },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(path.join(dir, 'hello.txt'), 'utf-8')).toBe('hello from patch\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
