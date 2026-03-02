import { describe, it, expect } from 'vitest';
import { StateBlock } from '../../src/blocks/state-block/index.js';

describe('StateBlock', () => {
  it('sets and gets values', async () => {
    const block = new StateBlock('state-test');
    await block.execute('set', { key: 'a', value: 1 });
    const value = await block.execute('get', { key: 'a' });
    expect(value).toBe(1);
  });

  it('merges objects and snapshots', async () => {
    const block = new StateBlock('state-test');
    await block.execute('set', { key: 'obj', value: { a: 1 } });
    await block.execute('merge', { key: 'obj', value: { b: 2 } });

    const merged = await block.execute('get', { key: 'obj' });
    expect(merged).toEqual({ a: 1, b: 2 });

    const snapshot = await block.execute('snapshot', {});
    expect(snapshot).toMatchObject({ obj: { a: 1, b: 2 } });
  });

  it('deletes values', async () => {
    const block = new StateBlock('state-test');
    await block.execute('set', { key: 'a', value: 1 });
    await block.execute('delete', { key: 'a' });
    const value = await block.execute('get', { key: 'a' });
    expect(value).toBeUndefined();
  });
});
