import { describe, it, expect } from 'vitest';
import { SessionBlock } from '../../src/blocks/session-block/index.js';

describe('SessionBlock', () => {
  it('creates session and tracks messages', async () => {
    const block = new SessionBlock('session-test');
    const session = await block.execute('create', { taskId: 'task-1', context: { foo: 'bar' } });
    const sessionId = (session as { id: string }).id;
    expect(session).toMatchObject({ taskId: 'task-1' });

    await block.execute('addMessage', { sessionId, role: 'user', content: 'Hi' });
    await block.execute('addMessage', { sessionId, role: 'assistant', content: 'Hello' });

    const messages = await block.execute('getMessages', { sessionId });
    expect(messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' }
    ]);
  });

  it('updates session context and list includes created sessions', async () => {
    const block = new SessionBlock('session-test');
    const created = await block.execute('create', { taskId: 'task-1', context: { foo: 'bar' } });
    const sessionId = (created as { id: string }).id;

    const updated = await block.execute('update', { sessionId, context: { baz: 1 } });
    expect(updated).toMatchObject({ context: { foo: 'bar', baz: 1 } });

    const list = block.list();
    expect(list.some(s => s.id === sessionId)).toBe(true);
  });

  it('throws when operating on missing session', async () => {
    const block = new SessionBlock('session-test');
    await expect(block.execute('addMessage', { sessionId: 'missing', role: 'user', content: 'x' })).rejects.toThrow(
      'Session missing not found'
    );
  });
});
