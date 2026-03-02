import { describe, it, expect } from 'vitest';
import { ProjectBlock } from '../../src/blocks/project-block/index.js';

describe('ProjectBlock', () => {
  it('creates, updates, and gets projects', async () => {
    const block = new ProjectBlock('project-test');
    const created = await block.execute('create', { name: 'P1', description: 'Initial' });
    const projectId = (created as { id: string }).id;

    expect(created).toMatchObject({ name: 'P1', description: 'Initial', bdSynced: false });

    const updated = await block.execute('update', { projectId, description: 'Updated' });
    expect(updated).toMatchObject({ id: projectId, description: 'Updated', bdSynced: false });

    const fetched = await block.execute('get', { projectId });
    expect(fetched).toMatchObject({ id: projectId, description: 'Updated' });
  });

  it('lists and deletes projects', async () => {
    const block = new ProjectBlock('project-test');
    const created = await block.execute('create', { name: 'P1' });
    const projectId = (created as { id: string }).id;

    const list = await block.execute('list', {});
    expect((list as Array<{ id: string }>).some(p => p.id === projectId)).toBe(true);

    const deleted = await block.execute('delete', { projectId });
    expect(deleted).toEqual({ deleted: true });
  });

  it('throws when updating unknown project', async () => {
    const block = new ProjectBlock('project-test');
    await expect(block.execute('update', { projectId: 'missing', description: 'x' })).rejects.toThrow(
      'Project missing not found'
    );
  });
});
