import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { writeProjectDreamMemory } from '../../../src/core/project-dream-memory-store.js';

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-dream-store-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('project dream memory store', () => {
  it('writes memory index, asset file, and state file', async () => {
    const root = await createRoot();
    const result = await writeProjectDreamMemory({
      projectSlug: 'webauto-abc123',
      taskId: 'nightly-dream:webauto-abc123:2026-04-01',
      projectId: 'webauto',
      status: 'completed',
      result: 'success',
      summary: 'added guardrail and delivery pattern',
      deliveryArtifacts: 'artifact: /tmp/a.log',
      evidence: ['test:ok', 'lint:ok'],
      generatedAt: new Date('2026-04-01T01:00:00.000Z'),
      memoryProjectsRoot: root,
    });

    const index = await fs.readFile(result.memoryIndexPath, 'utf-8');
    const asset = await fs.readFile(result.assetPath, 'utf-8');
    const state = await fs.readFile(result.dreamStatePath, 'utf-8');
    expect(index).toContain('## Nightly Dream Assets');
    expect(index).toContain('taskId=nightly-dream:webauto-abc123:2026-04-01');
    expect(asset).toContain('# Project Dream Asset');
    expect(asset).toContain('added guardrail and delivery pattern');
    expect(state).toContain('"nightly-dream:webauto-abc123:2026-04-01"');
  });

  it('is idempotent for same runId line in MEMORY.md', async () => {
    const root = await createRoot();
    const input = {
      projectSlug: 'webauto-abc123',
      taskId: 'nightly-dream:webauto-abc123:2026-04-01',
      projectId: 'webauto',
      status: 'completed',
      result: 'success' as const,
      summary: 'summary pass 1',
      generatedAt: new Date('2026-04-01T01:00:00.000Z'),
      memoryProjectsRoot: root,
    };
    const first = await writeProjectDreamMemory(input);
    await writeProjectDreamMemory({
      ...input,
      summary: 'summary pass 2',
      generatedAt: new Date('2026-04-01T01:30:00.000Z'),
    });
    const index = await fs.readFile(first.memoryIndexPath, 'utf-8');
    const lineCount = index.split('\n').filter((line) => line.includes('taskId=nightly-dream:webauto-abc123:2026-04-01')).length;
    expect(lineCount).toBe(1);
    expect(index).toContain('summary=summary pass 2');
  });

  it('normalizes slug to keep writes constrained under project root', async () => {
    const root = await createRoot();
    const result = await writeProjectDreamMemory({
      projectSlug: '../../escape-attempt',
      taskId: 'nightly-dream:escape-attempt:2026-04-01',
      projectId: 'escape-attempt',
      status: 'completed',
      result: 'success',
      summary: 'attempt path escape',
      memoryProjectsRoot: root,
    });
    const normalizedRoot = path.resolve(root);
    expect(path.resolve(result.projectRoot).startsWith(normalizedRoot)).toBe(true);
    expect(path.resolve(result.assetPath).startsWith(normalizedRoot)).toBe(true);
  });
});
