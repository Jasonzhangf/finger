import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeFileAtomicSync } from '../../../src/core/atomic-write.js';

describe('atomic-write', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop();
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('writes file atomically in sync mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-atomic-write-sync-'));
    cleanupPaths.push(root);
    const filePath = join(root, 'a', 'state.json');

    writeFileAtomicSync(filePath, '{"ok":1}');
    writeFileAtomicSync(filePath, '{"ok":2}');

    expect(readFileSync(filePath, 'utf-8')).toBe('{"ok":2}');
  });

  it('supports concurrent async writes without tmp-path collision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'finger-atomic-write-async-'));
    cleanupPaths.push(root);
    const filePath = join(root, 'b', 'state.json');

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writeFileAtomic(filePath, JSON.stringify({ index })),
      ),
    );

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { index: number };
    expect(typeof parsed.index).toBe('number');
    expect(parsed.index).toBeGreaterThanOrEqual(0);
    expect(parsed.index).toBeLessThan(24);
  });
});
