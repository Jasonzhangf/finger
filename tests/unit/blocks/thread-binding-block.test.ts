import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadBindingBlock } from '../../../src/blocks/thread-binding-block/index.js';

describe('ThreadBindingBlock', () => {
  let block: ThreadBindingBlock;

  beforeEach(() => {
    block = new ThreadBindingBlock('test-thread-binding');
  });

  describe('bind (create/update)', () => {
    it('should create new binding', () => {
      const binding = block.bind('discord', 'thread-123', 'session-abc');

      expect(binding.id).toBeDefined();
      expect(binding.channel).toBe('discord');
      expect(binding.threadId).toBe('thread-123');
      expect(binding.sessionId).toBe('session-abc');
      expect(binding.createdAt).toBeDefined();
      expect(binding.updatedAt).toBeDefined();
    });

    it('should update existing binding', () => {
      const b1 = block.bind('discord', 'thread-123', 'session-1', { accountId: 'acc-1' });
      const b2 = block.bind('discord', 'thread-123', 'session-2', { accountId: 'acc-2' });

      expect(b1.id).toBe(b2.id); // same binding id
      expect(b2.sessionId).toBe('session-2');
      expect(b2.accountId).toBe('acc-2');
    });

    it('should support runtimeSessionId and metadata', () => {
      const binding = block.bind('slack', 'thread-456', 'session-xyz', {
        accountId: 'acc-123',
        runtimeSessionId: 'runtime-abc',
        metadata: { source: 'webhook' }
      });

      expect(binding.runtimeSessionId).toBe('runtime-abc');
      expect(binding.metadata).toEqual({ source: 'webhook' });
    });
  });

  describe('unbind (close)', () => {
    it('should unbind existing binding', () => {
      block.bind('discord', 'thread-123', 'session-abc');
      const result = block.unbind('discord', 'thread-123');

      expect(result.unbound).toBe(true);
    });

    it('should return false for non-existent binding', () => {
      const result = block.unbind('discord', 'nonexistent');
      expect(result.unbound).toBe(false);
    });

    it('should clear indexes after unbind', () => {
      block.bind('discord', 'thread-123', 'session-1');
      block.bind('discord', 'thread-456', 'session-2');
      block.unbind('discord', 'thread-123');

      const bySession = block.listBySession('session-1');
      const byChannel = block.listByChannel('discord');

      expect(bySession).toHaveLength(0);
      expect(byChannel).toHaveLength(1);
    });
  });

  describe('get (resolve by channel+thread)', () => {
    it('should get binding by channel and threadId', () => {
      block.bind('discord', 'thread-123', 'session-abc');
      const binding = block.get('discord', 'thread-123');

      expect(binding).toBeDefined();
      expect(binding?.threadId).toBe('thread-123');
    });

    it('should return undefined for non-existent binding', () => {
      const binding = block.get('discord', 'nonexistent');
      expect(binding).toBeUndefined();
    });
  });

  describe('list (resolve all)', () => {
    it('should list all bindings', () => {
      block.bind('discord', 'thread-1', 'session-1');
      block.bind('slack', 'thread-2', 'session-2');
      block.bind('discord', 'thread-3', 'session-3');

      const bindings = block.list();
      expect(bindings).toHaveLength(3);
    });
  });

  describe('listBySession (resolve by session)', () => {
    it('should list bindings by sessionId', () => {
      block.bind('discord', 'thread-1', 'session-1');
      block.bind('slack', 'thread-2', 'session-1');
      block.bind('discord', 'thread-3', 'session-2');

      const bindings = block.listBySession('session-1');
      expect(bindings).toHaveLength(2);
      expect(bindings.every(b => b.sessionId === 'session-1')).toBe(true);
    });
  });

  describe('listByChannel (resolve by channel)', () => {
    it('should list bindings by channel', () => {
      block.bind('discord', 'thread-1', 'session-1');
      block.bind('discord', 'thread-2', 'session-2');
      block.bind('slack', 'thread-3', 'session-3');

      const bindings = block.listByChannel('discord');
      expect(bindings).toHaveLength(2);
      expect(bindings.every(b => b.channel === 'discord')).toBe(true);
    });
  });

  describe('execute routing', () => {
    it('should route bind command', async () => {
      const binding = await block.execute('bind', {
        channel: 'discord',
        threadId: 'thread-123',
        sessionId: 'session-abc'
      });
      expect(binding).toHaveProperty('id');
    });

    it('should route unbind command', async () => {
      block.bind('discord', 'thread-123', 'session-abc');
      const result = await block.execute('unbind', {
        channel: 'discord',
        threadId: 'thread-123'
      });
      expect(result).toEqual({ unbound: true });
    });

    it('should route get command', async () => {
      block.bind('discord', 'thread-123', 'session-abc');
      const binding = await block.execute('get', {
        channel: 'discord',
        threadId: 'thread-123'
      });
      expect(binding).toBeDefined();
    });

    it('should route list command', async () => {
      await block.execute('bind', {
        channel: 'discord',
        threadId: 'thread-123',
        sessionId: 'session-abc'
      });
      const bindings = await block.execute('list', {});
      expect(Array.isArray(bindings)).toBe(true);
    });
  });
});
