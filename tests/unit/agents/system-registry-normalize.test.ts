import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeProjectPath, projectIdFromPath } from '../../../src/agents/finger-system-agent/registry.js';

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const next = tempPaths.pop();
    if (!next) continue;
    try {
      fs.rmSync(next, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe('finger-system registry project path normalization', () => {
  it('collapses symlink aliases to one project id', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-registry-path-'));
    tempPaths.push(base);
    const realDir = path.join(base, 'real');
    const linkDir = path.join(base, 'link');
    fs.mkdirSync(realDir, { recursive: true });
    fs.symlinkSync(realDir, linkDir);

    const normalizedReal = normalizeProjectPath(realDir);
    const normalizedLink = normalizeProjectPath(linkDir);
    expect(normalizedLink).toBe(normalizedReal);
    expect(projectIdFromPath(linkDir)).toBe(projectIdFromPath(realDir));
  });
});

