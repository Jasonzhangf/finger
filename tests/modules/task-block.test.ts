import { describe, it, expect } from 'vitest';
import { TaskBlock } from '../../src/blocks/task-block/index.js';

describe('TaskBlock', () => {
  it('creates tasks with defaults and returns by get', async () => {
    const block = new TaskBlock('task-test');
    const created = await block.execute('create', { title: 'T1' });
    expect(created).toMatchObject({ title: 'T1', status: 'open', priority: 1 });

    const fetched = await block.execute('get', { id: (created as { id: string }).id });
    expect(fetched).toMatchObject({ title: 'T1' });
  });

  it('updates status and tracks status change in state', async () => {
    const block = new TaskBlock('task-test');
    const created = await block.execute('create', { title: 'T1' });
    const id = (created as { id: string }).id;

    const updated = await block.execute('update', { id, status: 'closed' });
    expect(updated).toMatchObject({ status: 'closed' });
    expect(block.state.data?.lastStatusChange).toMatchObject({ id, from: 'open', to: 'closed' });
  });

  it('lists and filters tasks', async () => {
    const block = new TaskBlock('task-test');
    await block.execute('create', { title: 'T1', status: 'open', priority: 1 });
    await block.execute('create', { title: 'T2', status: 'closed', priority: 5, isMainPath: true });
    await block.execute('create', { title: 'T3', status: 'open', priority: 3, isMainPath: true });

    const open = await block.execute('list', { status: 'open' });
    expect((open as Array<{ status: string }>).every(t => t.status === 'open')).toBe(true);

    const mainPath = await block.execute('list', { isMainPath: true });
    expect((mainPath as Array<{ isMainPath: boolean }>).every(t => t.isMainPath)).toBe(true);
  });

  it('returns ready tasks only when dependencies are closed', async () => {
    const block = new TaskBlock('task-test');
    const dep = await block.execute('create', { id: 'dep-1', title: 'Dep', status: 'open' });
    const depId = (dep as { id: string }).id;
    await block.execute('create', { id: 'parent-1', title: 'Parent', status: 'open', dependencies: [depId] });

    const readyBefore = await block.execute('ready', {});
    expect((readyBefore as Array<{ title: string }>).some(t => t.title === 'Parent')).toBe(false);

    await block.execute('update', { id: depId, status: 'closed' });
    const readyAfter = await block.execute('ready', {});
    expect((readyAfter as Array<{ title: string }>).some(t => t.title === 'Parent')).toBe(true);
  });

  it('throws when updating unknown task', async () => {
    const block = new TaskBlock('task-test');
    await expect(block.execute('update', { id: 'missing', title: 'X' })).rejects.toThrow(
      'Task missing not found'
    );
  });
});
