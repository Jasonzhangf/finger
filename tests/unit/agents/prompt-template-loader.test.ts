import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHotPrompt } from '../../../src/agents/base/prompt-template-loader.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('prompt template loader', () => {
  it('uses inline prompt when file not found', () => {
    const resolved = resolveHotPrompt({
      inlinePrompt: 'inline default',
      candidatePaths: ['/tmp/not-found-prompt.md'],
    });

    expect(resolved.source).toBe('inline');
    expect(resolved.prompt).toBe('inline default');
  });

  it('loads prompt from file and reflects updates on dirty mtime', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'finger-prompt-loader-'));
    tempDirs.push(dir);
    const promptPath = path.join(dir, 'prompt.md');

    writeFileSync(promptPath, 'version-1', 'utf-8');
    const first = resolveHotPrompt({
      inlinePrompt: 'inline default',
      candidatePaths: [promptPath],
    });
    expect(first.source).toBe('file');
    expect(first.prompt).toBe('version-1');

    writeFileSync(promptPath, 'version-2', 'utf-8');
    const second = resolveHotPrompt({
      inlinePrompt: 'inline default',
      candidatePaths: [promptPath],
    });
    expect(second.source).toBe('file');
    expect(second.prompt).toBe('version-2');
  });
});

