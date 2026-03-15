import { describe, it, expect, beforeEach } from 'vitest';
import { MailboxBlock } from '../../../src/blocks/mailbox-block/index.js';

describe('MailboxBlock', () => {
  let block: MailboxBlock;

  beforeEach(() => {
    block = new MailboxBlock('test-mailbox');
  });

  describe('append', () => {
    it('should append message and return id/seq', () => {
      const result = block.append('agent-1', { type: 'test', data: 'hello' });

      expect(result.id).toBeDefined();
      expect(result.id).toMatch(/^msg-\d+-[a-z0-9]+$/);
      expect(result.seq).toBe(1);
    });

    it('should increment seq on multiple appends', () => {
      const r1 = block.append('agent-1', { data: 1 });
      const r2 = block.append('agent-1', { data: 2 });
      const r3 = block.append('agent-2', { data: 3 });

      expect(r1.seq).toBe(1);
      expect(r2.seq).toBe(2);
      expect(r3.seq).toBe(3);
    });

    it('should store message with all fields', () => {
      const { id } = block.append('agent-1', { text: 'hello' }, {
        sender: 'user-1',
        sessionId: 'session-1',
        channel: 'discord',
        threadId: 'thread-1',
      });

      const msg = block.get(id);
      expect(msg).toBeDefined();
      expect(msg?.target).toBe('agent-1');
      expect(msg?.content).toEqual({ text: 'hello' });
      expect(msg?.sender).toBe('user-1');
      expect(msg?.sessionId).toBe('session-1');
      expect(msg?.channel).toBe('discord');
      expect(msg?.threadId).toBe('thread-1');
      expect(msg?.status).toBe('pending');
    });
  });

  describe('list', () => {
    beforeEach(() => {
      block.append('agent-1', { data: 1 }, { sessionId: 's1' });
      block.append('agent-2', { data: 2 }, { sessionId: 's1' });
      block.append('agent-1', { data: 3 }, { sessionId: 's2' });
    });

    it('should list all messages', () => {
      const messages = block.list({});
      expect(messages).toHaveLength(3);
    });

    it('should filter by target', () => {
      const messages = block.list({ target: 'agent-1' });
      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.target === 'agent-1')).toBe(true);
    });

    it('should filter by sessionId', () => {
      const messages = block.list({ sessionId: 's1' });
      expect(messages).toHaveLength(2);
      expect(messages.every(m => m.sessionId === 's1')).toBe(true);
    });

    it('should support limit/offset', () => {
      const messages = block.list({ limit: 2 });
      expect(messages).toHaveLength(2);
    });
  });

  describe('ack', () => {
    it('should mark message as acknowledged', () => {
      const { id } = block.append('agent-1', { data: 'test' });
      const result = block.ack(id);

      expect(result.acked).toBe(true);
      const msg = block.get(id);
      expect(msg?.ackAt).toBeDefined();
    });

    it('should return false for non-existent message', () => {
      const result = block.ack('nonexistent');
      expect(result.acked).toBe(false);
    });
  });

  describe('execute', () => {
    it('should route append command', async () => {
      const result = await block.execute('append', {
        target: 'agent-1',
        content: { test: true }
      });
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('seq');
    });

    it('should route list command', async () => {
      await block.execute('append', { target: 'agent-1', content: {} });
      const messages = await block.execute('list', {});
      expect(Array.isArray(messages)).toBe(true);
    });

    it('should route ack command', async () => {
      const { id } = block.append('agent-1', {});
      const result = await block.execute('ack', { id });
      expect(result).toEqual({ acked: true });
    });
  });
});
