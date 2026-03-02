import { describe, it, expect } from 'vitest';
import { StorageBlock } from '../../src/blocks/storage-block/index.js';
import { withTempDir } from './_helpers/block-test-utils.js';

describe('StorageBlock', () => {
  it('saves and loads in memory mode', async () => {
    const block = new StorageBlock('storage-test', 'memory');
    await block.initialize();

    const saved = await block.execute('save', { key: 'k1', value: { a: 1 } });
    expect(saved).toMatchObject({ saved: true, key: 'k1' });

    const loaded = await block.execute('load', { key: 'k1' });
    expect(loaded).toEqual({ a: 1 });

    const exists = await block.execute('exists', { key: 'k1' });
    expect(exists).toEqual({ exists: true });

    const list = await block.execute('list', {});
    expect(list).toEqual(['k1']);

    const deleted = await block.execute('delete', { key: 'k1' });
    expect(deleted).toEqual({ deleted: true });
  });

  it('saves and loads in file mode under ~/.finger/tests/tmp', async () => {
    await withTempDir(async (dir) => {
      const block = new StorageBlock('storage-test', 'file', dir);
      await block.initialize();

      await block.execute('save', { key: 'k2', value: { b: 2 } });
      const loaded = await block.execute('load', { key: 'k2' });
      expect(loaded).toEqual({ b: 2 });

      const exists = await block.execute('exists', { key: 'k2' });
      expect(exists).toEqual({ exists: true });

      const deleted = await block.execute('delete', { key: 'k2' });
      expect(deleted).toEqual({ deleted: true });
    });
  });
});
