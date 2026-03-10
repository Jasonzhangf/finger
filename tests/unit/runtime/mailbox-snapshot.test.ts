import { describe, it, expect } from 'vitest';
import { Mailbox } from '../../../src/server/mailbox.js';
import { buildMailboxSnapshot } from '../../../src/runtime/mailbox-snapshot.js';

describe('buildMailboxSnapshot', () => {
  it('should return empty snapshot when no messages', () => {
    const mailbox = new Mailbox();
    const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0);
    expect(snapshot.currentSeq).toBe(0);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.hasUnread).toBe(false);
  });

  it('should return delta entries for a session', () => {
    const mailbox = new Mailbox();
    mailbox.createMessage('agent-1', 'hello', { sessionId: 'session-1', category: 'notification' });
    mailbox.createMessage('agent-1', 'ignore me', { sessionId: 'session-2', category: 'notification' });
    mailbox.createMessage('agent-1', 'task done', { sessionId: 'session-1', category: 'task-result' });

    const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0);
    expect(snapshot.currentSeq).toBe(3);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0].shortDescription).toBe('hello');
    expect(snapshot.entries[1].shortDescription).toBe('task done');
    expect(snapshot.hasUnread).toBe(true);
  });

  it('should respect lastSeenSeq', () => {
    const mailbox = new Mailbox();
    mailbox.createMessage('agent-1', 'first', { sessionId: 'session-1' });
    mailbox.createMessage('agent-1', 'second', { sessionId: 'session-1' });
    mailbox.createMessage('agent-1', 'third', { sessionId: 'session-1' });

    const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 2);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].seq).toBe(3);
    expect(snapshot.entries[0].shortDescription).toBe('third');
  });
});
