import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeProjectPathCanonical } from '../../../src/common/path-normalize.js';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const next = tempPaths.pop();
    if (!next) continue;
    try {
      fs.rmSync(next, { recursive: true, force: true });
    } catch {
      // ignore test cleanup errors
    }
  }
});

describe('normalizeProjectPathCanonical', () => {
  it('normalizes relative path to absolute path', () => {
    const normalized = normalizeProjectPathCanonical('.');
    expect(path.isAbsolute(normalized)).toBe(true);
  });

  it('collapses symlink aliases when available', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-path-norm-'));
    tempPaths.push(base);

    const realDir = path.join(base, 'real');
    const linkDir = path.join(base, 'link');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkDir);

    const normalizedReal = normalizeProjectPathCanonical(realDir);
    const normalizedLink = normalizeProjectPathCanonical(linkDir);
    expect(normalizedLink).toBe(normalizedReal);
  });
});

