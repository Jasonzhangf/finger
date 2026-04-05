import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  it('ignores invalid env override and never returns unavailable custom path', () => {
    process.env.FINGER_CODEX_APPLY_PATCH_BIN = '/tmp/custom-apply-patch';
    const resolved = resolveApplyPatchCommand(process.cwd());
    expect(resolved?.commandArrayPrefix[0]).not.toBe('/tmp/custom-apply-patch');
  });

  it('applies add-file patch when apply_patch command is available', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-apply-patch-'));
    try {
      const fakeApplyPatchBin = path.join(dir, 'fake-apply-patch.cjs');
      writeFileSync(
        fakeApplyPatchBin,
        `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const patch = process.argv[2] || '';
const addFileMatch = patch.match(/\\*\\*\\* Add File: (.+)/);
if (!addFileMatch) {
  process.stderr.write('unsupported patch');
  process.exit(1);
}
const fileName = addFileMatch[1].trim();
const lines = patch.split('\\n').filter((line) => line.startsWith('+')).map((line) => line.slice(1));
const output = lines.join('\\n') + '\\n';
fs.writeFileSync(path.join(process.cwd(), fileName), output, 'utf8');
`,
        'utf-8',
      );
      chmodSync(fakeApplyPatchBin, 0o755);
      process.env.FINGER_CODEX_APPLY_PATCH_BIN = fakeApplyPatchBin;

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

  it('applies update-file patch without external apply_patch binary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'finger-apply-patch-update-'));
    try {
      const file = path.join(dir, 'note.txt');
      writeFileSync(file, 'line1\nline2\nline3\n', 'utf-8');
      delete process.env.FINGER_CODEX_APPLY_PATCH_BIN;

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

      const result = await applyPatchTool.execute(
        { input: patch },
        {
          ...TEST_CONTEXT_BASE,
          cwd: dir,
        },
      );

      expect(result.ok).toBe(true);
      expect(readFileSync(file, 'utf-8')).toBe('line1\nline2-updated\nline3\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
