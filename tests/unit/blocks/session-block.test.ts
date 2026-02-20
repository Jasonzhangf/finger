import { describe, it, expect, beforeEach } from 'vitest';
import { SessionBlock } from '../../../src/blocks/session-block/index.js';

describe('SessionBlock', () => {
  let block: SessionBlock;

  beforeEach(() => {
    block = new SessionBlock('test-session');
  });

  describe('constructor', () => {
    it('should initialize with id and type', () => {
      expect(block.id).toBe('test-session');
      expect(block.type).toBe('session');
    });

    it('should have all required capabilities', () => {
      const caps = block.capabilities;
      expect(caps.functions).toContain('create');
      expect(caps.functions).toContain('get');
      expect(caps.functions).toContain('update');
      expect(caps.functions).toContain('delete');
      expect(caps.functions).toContain('addMessage');
      expect(caps.functions).toContain('getMessages');
    });
  });

  describe('execute - create', () => {
    it('should create a session', async () => {
      const session: any = await block.execute('create', {
        taskId: 'task-1',
        context: { key: 'value' },
      });
      expect(session.id).toBeDefined();
      expect(session.taskId).toBe('task-1');
      expect(session.context.key).toBe('value');
    });
  });

  describe('execute - get', () => {
    it('should get a session by id', async () => {
      const created: any = await block.execute('create', { taskId: 'task-1' });
      const session = await block.execute('get', { sessionId: created.id });
      expect(session).toBeDefined();
      expect((session as any).id).toBe(created.id);
    });

    it('should return undefined for non-existent session', async () => {
      const session = await block.execute('get', { sessionId: 'non-existent' });
      expect(session).toBeUndefined();
    });
  });

  describe('execute - update', () => {
    it('should update session context', async () => {
      const created: any = await block.execute('create', { taskId: 'task-1' });
      const updated: any = await block.execute('update', {
        sessionId: created.id,
        context: { newKey: 'newValue' },
      });
      expect(updated.context.newKey).toBe('newValue');
    });

    it('should throw for non-existent session', async () => {
      await expect(block.execute('update', {
        sessionId: 'non-existent',
        context: {},
      })).rejects.toThrow('not found');
    });
  });

  describe('execute - delete', () => {
    it('should delete a session', async () => {
      const created: any = await block.execute('create', { taskId: 'task-1' });
      const result = await block.execute('delete', { sessionId: created.id });
      expect(result.deleted).toBe(true);
      const session = await block.execute('get', { sessionId: created.id });
      expect(session).toBeUndefined();
    });

    it('should return false for non-existent session', async () => {
      const result = await block.execute('delete', { sessionId: 'non-existent' });
      expect(result.deleted).toBe(false);
    });
  });

  describe('execute - addMessage', () => {
    it('should add a message to session', async () => {
      const created: any = await block.execute('create', { taskId: 'task-1' });
      const session: any = await block.execute('addMessage', {
        sessionId: created.id,
        role: 'user',
        content: 'Hello',
      });
      expect(session.messages.length).toBe(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hello');
    });

    it('should throw for non-existent session', async () => {
      await expect(block.execute('addMessage', {
        sessionId: 'non-existent',
        role: 'user',
        content: 'Hello',
      })).rejects.toThrow('not found');
    });
  });

  describe('execute - getMessages', () => {
    it('should get all messages from session', async () => {
      const created: any = await block.execute('create', { taskId: 'task-1' });
      await block.execute('addMessage', { sessionId: created.id, role: 'user', content: 'Hello' });
      await block.execute('addMessage', { sessionId: created.id, role: 'assistant', content: 'Hi' });
      const messages = await block.execute('getMessages', { sessionId: created.id });
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(2);
    });

    it('should return empty array for non-existent session', async () => {
      const messages = await block.execute('getMessages', { sessionId: 'non-existent' });
      expect(Array.isArray(messages)).toBe(true);
      expect(messages.length).toBe(0);
    });
  });

  describe('execute - unknown command', () => {
    it('should throw for unknown command', async () => {
      await expect(block.execute('unknown', {})).rejects.toThrow('Unknown command');
    });
  });
});
