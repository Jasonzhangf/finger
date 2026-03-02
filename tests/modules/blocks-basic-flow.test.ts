import { describe, it, expect } from 'vitest';
import { TaskBlock } from '../../src/blocks/task-block/index.js';
import { SessionBlock } from '../../src/blocks/session-block/index.js';
import { StateBlock } from '../../src/blocks/state-block/index.js';
import { StorageBlock } from '../../src/blocks/storage-block/index.js';
import { withTempDir } from './_helpers/block-test-utils.js';

describe('Blocks Basic Flow', () => {
  it('links task -> session -> state -> storage', async () => {
    await withTempDir(async (dir) => {
      const tasks = new TaskBlock('task-flow');
      const sessions = new SessionBlock('session-flow');
      const state = new StateBlock('state-flow');
      const storage = new StorageBlock('storage-flow', 'file', dir);

      await storage.initialize();

      const task = await tasks.execute('create', { title: 'Flow Task', description: 'flow' });
      const taskId = (task as { id: string }).id;

      const session = await sessions.execute('create', { taskId, context: { step: 1 } });
      const sessionId = (session as { id: string }).id;

      await sessions.execute('addMessage', { sessionId, role: 'user', content: 'start' });
      const messages = await sessions.execute('getMessages', { sessionId });
      expect(messages).toEqual([{ role: 'user', content: 'start' }]);

      await state.execute('set', { key: 'activeSession', value: sessionId });
      const activeSession = await state.execute('get', { key: 'activeSession' });
      expect(activeSession).toBe(sessionId);

      await storage.execute('save', {
        key: `session-${sessionId}`,
        value: { sessionId, taskId, messageCount: (messages as Array<unknown>).length },
      });

      const stored = await storage.execute('load', { key: `session-${sessionId}` });
      expect(stored).toEqual({ sessionId, taskId, messageCount: 1 });
    });
  });
});
