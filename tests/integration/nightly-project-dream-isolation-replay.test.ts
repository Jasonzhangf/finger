import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { writeProjectDreamMemory } from '../../src/core/project-dream-memory-store.js';

const roots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-nightly-dream-int-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0, roots.length).map(async (root) => {
    await fs.rm(root, { recursive: true, force: true });
  }));
});

describe('nightly project dream isolation replay', () => {
  it('runs multi-project writes in parallel with isolated outputs', async () => {
    const root = await createTempRoot();
    const [a, b] = await Promise.all([
      writeProjectDreamMemory({
        projectSlug: 'project-a-123',
        taskId: 'nightly-dream:project-a-123:2026-04-01',
        projectId: 'project-a',
        status: 'completed',
        result: 'success',
        summary: 'guardrail + playbook generated',
        deliveryArtifacts: 'rules_added=2; delivery_pattern=1',
        evidence: ['slot:100-120'],
        memoryProjectsRoot: root,
      }),
      writeProjectDreamMemory({
        projectSlug: 'project-b-456',
        taskId: 'nightly-dream:project-b-456:2026-04-01',
        projectId: 'project-b',
        status: 'completed',
        result: 'success',
        summary: 'rule + delivery pattern generated',
        deliveryArtifacts: 'rules_added=1; guardrail=1',
        evidence: ['slot:200-250'],
        memoryProjectsRoot: root,
      }),
    ]);

    expect(a.projectRoot).not.toBe(b.projectRoot);
    expect(path.resolve(a.projectRoot).startsWith(path.resolve(root))).toBe(true);
    expect(path.resolve(b.projectRoot).startsWith(path.resolve(root))).toBe(true);
    expect(a.projectRoot).toContain('project-a-123');
    expect(b.projectRoot).toContain('project-b-456');
    const aIndex = await fs.readFile(a.memoryIndexPath, 'utf-8');
    const bIndex = await fs.readFile(b.memoryIndexPath, 'utf-8');
    const aAsset = await fs.readFile(a.assetPath, 'utf-8');
    const bAsset = await fs.readFile(b.assetPath, 'utf-8');
    expect(aIndex).toContain('taskId=nightly-dream:project-a-123:2026-04-01');
    expect(bIndex).toContain('taskId=nightly-dream:project-b-456:2026-04-01');
    expect(aAsset.toLowerCase()).toContain('guardrail');
    expect(aAsset.toLowerCase()).toContain('playbook');
    expect(bAsset.toLowerCase()).toContain('rule');
    expect(bAsset.toLowerCase()).toContain('delivery pattern');
  });

  it('keeps successful project output when another project run fails', async () => {
    const root = await createTempRoot();
    const settled = await Promise.allSettled([
      writeProjectDreamMemory({
        projectSlug: 'project-good-001',
        taskId: 'nightly-dream:project-good-001:2026-04-01',
        projectId: 'project-good',
        status: 'completed',
        result: 'success',
        summary: 'rules and guardrail persisted',
        evidence: ['slot:300-330'],
        memoryProjectsRoot: root,
      }),
      writeProjectDreamMemory({
        projectSlug: 'project-bad-002',
        taskId: '',
        projectId: 'project-bad',
        status: 'failed',
        result: 'failure',
        summary: 'invalid run',
        memoryProjectsRoot: root,
      }),
    ]);

    const success = settled.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<{
      projectRoot: string;
      memoryIndexPath: string;
      dreamStatePath: string;
      assetPath: string;
    }>;
    const failed = settled.find((item) => item.status === 'rejected') as PromiseRejectedResult | undefined;

    expect(success).toBeTruthy();
    expect(failed).toBeTruthy();
    expect(String(failed?.reason ?? '')).toContain('projectSlug and taskId are required');
    const okIndex = await fs.readFile(success.value.memoryIndexPath, 'utf-8');
    expect(okIndex).toContain('project-good-001');
    expect(okIndex).toContain('taskId=nightly-dream:project-good-001:2026-04-01');
  });
});
