import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  acquireProjectDreamLock,
  releaseProjectDreamLock,
} from '../../../src/core/project-dream-lock.js';

const tempRoots: string[] = [];

async function createRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-dream-lock-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  }));
});

describe('project dream lock', () => {
  it('acquires and releases lock by runId', async () => {
    const root = await createRoot();
    const first = await acquireProjectDreamLock({
      projectSlug: 'webauto-abc123',
      runId: 'nightly-dream:webauto-abc123:2026-04-01',
      memoryProjectsRoot: root,
    });
    expect(first.acquired).toBe(true);

    const released = await releaseProjectDreamLock({
      projectSlug: 'webauto-abc123',
      runId: 'nightly-dream:webauto-abc123:2026-04-01',
      memoryProjectsRoot: root,
    });
    expect(released.released).toBe(true);
  });

  it('treats same runId as reentrant and different runId as busy', async () => {
    const root = await createRoot();
    await acquireProjectDreamLock({
      projectSlug: 'finger-project',
      runId: 'nightly-dream:finger-project:2026-04-01',
      memoryProjectsRoot: root,
    });

    const reentrant = await acquireProjectDreamLock({
      projectSlug: 'finger-project',
      runId: 'nightly-dream:finger-project:2026-04-01',
      memoryProjectsRoot: root,
    });
    expect(reentrant.acquired).toBe(false);
    expect(reentrant.reason).toBe('reentrant');

    const busy = await acquireProjectDreamLock({
      projectSlug: 'finger-project',
      runId: 'nightly-dream:finger-project:2026-04-02',
      memoryProjectsRoot: root,
    });
    expect(busy.acquired).toBe(false);
    expect(busy.reason).toBe('busy');
  });

  it('does not release lock when runId mismatches', async () => {
    const root = await createRoot();
    await acquireProjectDreamLock({
      projectSlug: 'finger-project',
      runId: 'nightly-dream:finger-project:2026-04-01',
      memoryProjectsRoot: root,
    });

    const mismatch = await releaseProjectDreamLock({
      projectSlug: 'finger-project',
      runId: 'nightly-dream:finger-project:2026-04-02',
      memoryProjectsRoot: root,
    });
    expect(mismatch.released).toBe(false);
    expect(mismatch.reason).toBe('run_id_mismatch');
  });

  it('replaces stale lock when ttl exceeded', async () => {
    const root = await createRoot();
    const slug = 'finger-project';
    const lockPath = path.join(root, slug, '.dream.lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const stale = {
      projectSlug: slug,
      runId: 'nightly-dream:finger-project:2026-03-31',
      createdAt: '2026-03-31T00:00:00.000Z',
      updatedAt: '2026-03-31T00:00:00.000Z',
    };
    await fs.writeFile(lockPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf-8');

    const next = await acquireProjectDreamLock({
      projectSlug: slug,
      runId: 'nightly-dream:finger-project:2026-04-01',
      lockTtlMs: 60_000,
      memoryProjectsRoot: root,
    });
    expect(next.acquired).toBe(true);
    expect(next.staleReplaced).toBe(true);
  });
});
