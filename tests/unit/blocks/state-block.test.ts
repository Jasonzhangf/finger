import { describe, it, expect, beforeEach } from 'vitest';
import { StateBlock } from '../../../src/blocks/state-block/index.js';

describe('StateBlock', () => {
  let block: StateBlock;

  beforeEach(() => {
    block = new StateBlock('test-state');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-state');
      expect(block.type).toBe('state');
    });

    it('should have correct capabilities', () => {
      expect(block.capabilities.functions).toContain('get');
      expect(block.capabilities.functions).toContain('set');
      expect(block.capabilities.functions).toContain('merge');
      expect(block.capabilities.functions).toContain('delete');
      expect(block.capabilities.functions).toContain('snapshot');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent key', () => {
      const value = block.get('non-existent');
      expect(value).toBeUndefined();
    });

    it('should return stored value', () => {
      block.set('my-key', 'my-value');
      const value = block.get('my-key');
      expect(value).toBe('my-value');
    });
  });

  describe('set', () => {
    it('should store a value', () => {
      const result = block.set('key1', 'value1');
      expect(result.key).toBe('key1');
      expect(result.updated).toBe(true);
      expect(block.get('key1')).toBe('value1');
    });

    it('should update existing value', () => {
      block.set('key', 'old');
      block.set('key', 'new');
      expect(block.get('key')).toBe('new');
    });
  });

  describe('merge', () => {
    it('should set new object value', () => {
      const result = block.merge('obj', { a: 1, b: 2 });
      expect(result.key).toBe('obj');
      expect(result.merged).toBe(true);
    });

    it('should merge with existing object', () => {
      block.set('obj', { a: 1, b: 2 });
      block.merge('obj', { b: 3, c: 4 });
      const value = block.get('obj') as Record<string, number>;
      expect(value.a).toBe(1);
      expect(value.b).toBe(3);
      expect(value.c).toBe(4);
    });

    it('should handle non-object existing value', () => {
      block.set('key', 'string-value');
      block.merge('key', { a: 1 });
      const value = block.get('key') as Record<string, number>;
      expect(value.a).toBe(1);
    });
  });

  describe('delete', () => {
    it('should delete an existing key', () => {
      block.set('key', 'value');
      const result = block.delete('key');
      expect(result.deleted).toBe(true);
      expect(block.get('key')).toBeUndefined();
    });

    it('should return false for non-existent key', () => {
      const result = block.delete('non-existent');
      expect(result.deleted).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('should return empty object for empty store', () => {
      const snapshot = block.snapshot();
      expect(Object.keys(snapshot)).toHaveLength(0);
    });

    it('should return all stored values', () => {
      block.set('key1', 'value1');
      block.set('key2', 123);
      block.set('key3', { nested: true });
      const snapshot = block.snapshot();
      expect(snapshot.key1).toBe('value1');
      expect(snapshot.key2).toBe(123);
      expect(snapshot.key3).toEqual({ nested: true });
    });
  });

  describe('execute', () => {
    it('should handle get command', async () => {
      block.set('exec-key', 'exec-value');
      const result = await block.execute('get', { key: 'exec-key' });
      expect(result).toBe('exec-value');
    });

    it('should handle set command', async () => {
      const result = await block.execute('set', { key: 'exec-key', value: 'exec-value' });
      expect(result.key).toBe('exec-key');
      expect(result.updated).toBe(true);
    });

    it('should handle merge command', async () => {
      block.set('exec-obj', { a: 1 });
      const result = await block.execute('merge', { key: 'exec-obj', value: { b: 2 } });
      expect(result.key).toBe('exec-obj');
      expect(result.merged).toBe(true);
    });

    it('should handle delete command', async () => {
      block.set('exec-key', 'value');
      const result = await block.execute('delete', { key: 'exec-key' });
      expect(result.deleted).toBe(true);
    });

    it('should handle snapshot command', async () => {
      block.set('key1', 'value1');
      const result = await block.execute('snapshot', {});
      expect(result).toEqual({ key1: 'value1' });
    });

    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
