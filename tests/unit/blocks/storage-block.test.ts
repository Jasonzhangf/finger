import { describe, it, expect, beforeEach } from 'vitest';
import { StorageBlock } from '../../../src/blocks/storage-block/index.js';

describe('StorageBlock', () => {
  let block: StorageBlock;

  beforeEach(() => {
    block = new StorageBlock('test-storage', 'memory');
  });
  
  describe('file backend', () => {
    let fileBlock: StorageBlock;
    
    beforeEach(() => {
      fileBlock = new StorageBlock('test-file-storage', 'file', './test-data');
    });
    
    it('should save to file backend', () => {
      const result = fileBlock.save({ key: 'file-key', value: { data: 'test' } });
      expect(result.saved).toBe(true);
    });
    
    it('should load from file backend', () => {
      fileBlock.save({ key: 'file-key', value: 'file-value' });
      const loaded = fileBlock.load({ key: 'file-key' });
      expect(loaded).toBe('file-value');
    });
    
    it('should delete from file backend', () => {
      fileBlock.save({ key: 'file-key', value: 'value' });
      const result = fileBlock.delete('file-key');
      expect(result.deleted).toBe(true);
    });
    
    it('should check exists in file backend', () => {
      fileBlock.save({ key: 'file-key', value: 'value' });
      const result = fileBlock.exists('file-key');
      expect(result.exists).toBe(true);
    });
    
    it('should return empty list for file backend', () => {
      fileBlock.save({ key: 'key1', value: 'v1' });
      const keys = fileBlock.list();
      expect(keys).toEqual([]);
    });
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-storage');
      expect(block.type).toBe('storage');
    });

    it('should have correct capabilities', () => {
      expect(block.capabilities.functions).toContain('save');
      expect(block.capabilities.functions).toContain('load');
      expect(block.capabilities.functions).toContain('delete');
      expect(block.capabilities.functions).toContain('exists');
      expect(block.capabilities.functions).toContain('list');
    });
  });

  describe('save', () => {
    it('should save value in memory backend', () => {
      const result = block.save({ key: 'my-key', value: 'my-value' });
      expect(result.saved).toBe(true);
      expect(result.key).toBe('my-key');
    });

    it('should retrieve saved value', () => {
      block.save({ key: 'key1', value: 'value1' });
      const loaded = block.load({ key: 'key1' });
      expect(loaded).toBe('value1');
    });
  });

  describe('load', () => {
    it('should return undefined for non-existent key', () => {
      const value = block.load({ key: 'non-existent' });
      expect(value).toBeUndefined();
    });

    it('should return saved object', () => {
      block.save({ key: 'obj', value: { a: 1, b: 2 } });
      const loaded = block.load({ key: 'obj' });
      expect(loaded).toEqual({ a: 1, b: 2 });
    });
  });

  describe('delete', () => {
    it('should delete existing key', () => {
      block.save({ key: 'key1', value: 'value1' });
      const result = block.delete('key1');
      expect(result.deleted).toBe(true);
      expect(block.load({ key: 'key1' })).toBeUndefined();
    });

    it('should return false for non-existent key', () => {
      const result = block.delete('non-existent');
      expect(result.deleted).toBe(false);
    });
  });

  describe('exists', () => {
    it('should return true for existing key', () => {
      block.save({ key: 'key1', value: 'value' });
      const result = block.exists('key1');
      expect(result.exists).toBe(true);
    });

    it('should return false for non-existent key', () => {
      const result = block.exists('non-existent');
      expect(result.exists).toBe(false);
    });
  });

  describe('list', () => {
    it('should return empty array for empty storage', () => {
      const keys = block.list();
      expect(keys).toEqual([]);
    });

    it('should return all keys', () => {
      block.save({ key: 'key1', value: 'v1' });
      block.save({ key: 'key2', value: 'v2' });
      block.save({ key: 'key3', value: 'v3' });
      const keys = block.list();
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
      expect(keys.length).toBe(3);
    });
  });

  describe('execute', () => {
    it('should handle save command', async () => {
      const result = await block.execute('save', { key: 'exec-key', value: 'exec-value' });
      expect(result).toEqual({ saved: true, key: 'exec-key' });
    });

    it('should handle load command', async () => {
      block.save({ key: 'exec-key', value: 'exec-value' });
      const result = await block.execute('load', { key: 'exec-key' });
      expect(result).toBe('exec-value');
    });

    it('should handle delete command', async () => {
      block.save({ key: 'exec-key', value: 'value' });
      const result = await block.execute('delete', { key: 'exec-key' });
      expect(result.deleted).toBe(true);
    });

    it('should handle exists command', async () => {
      block.save({ key: 'exec-key', value: 'value' });
      const result = await block.execute('exists', { key: 'exec-key' });
      expect(result.exists).toBe(true);
    });

    it('should handle list command', async () => {
      block.save({ key: 'key1', value: 'v1' });
      const result = await block.execute('list', {});
      expect(result).toContain('key1');
    });

    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
