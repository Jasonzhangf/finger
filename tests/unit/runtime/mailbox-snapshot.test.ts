import { describe, it, expect } from 'vitest';
import { Mailbox } from '../../../src/server/mailbox.js';
import {
  buildMailboxSnapshot,
  hasNewUnreadSinceLastNotified,
  getNewUnreadEntries,
} from '../../../src/runtime/mailbox-snapshot.js';

describe('mailbox snapshot functions', () => {
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

    it('should include lastNotifiedSeq', () => {
      const mailbox = new Mailbox();
      mailbox.createMessage('agent-1', 'msg', { sessionId: 'session-1' });
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 1);
      expect(snapshot.lastNotifiedSeq).toBe(1);
    });
  });

  describe('hasNewUnreadSinceLastNotified', () => {
    it('should return false if no unread', () => {
      const mailbox = new Mailbox();
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1');
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(false);
    });

    it('should return true if unread and never notified', () => {
      const mailbox = new Mailbox();
      mailbox.createMessage('agent-1', 'new msg', { sessionId: 'session-1' });
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1');
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
    });

    it('should return true if new unread after last notified', () => {
      const mailbox = new Mailbox();
      mailbox.createMessage('agent-1', 'old', { sessionId: 'session-1' });
      mailbox.createMessage('agent-1', 'new', { sessionId: 'session-1' });
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 1);
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
    });

    it('should return false if no new unread after last notified', () => {
      const mailbox = new Mailbox();
      mailbox.createMessage('agent-1', 'already notified', { sessionId: 'session-1' });
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 1);
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(false);
    });
  });

  describe('getNewUnreadEntries', () => {
    it('should return only new entries since last notified', () => {
      const mailbox = new Mailbox();
      mailbox.createMessage('agent-1', 'old1', { sessionId: 'session-1' });
      mailbox.createMessage('agent-1', 'old2', { sessionId: 'session-1' });
      mailbox.createMessage('agent-1', 'new1', { sessionId: 'session-1' });
      mailbox.createMessage('agent-1', 'new2', { sessionId: 'session-1' });

      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 2);
      const newEntries = getNewUnreadEntries(snapshot);
      expect(newEntries.length).toBe(2);
      expect(newEntries[0].seq).toBe(3);
      expect(newEntries[0].shortDescription).toBe('new1');
      expect(newEntries[1].seq).toBe(4);
      expect(newEntries[1].shortDescription).toBe('new2');
    });
  });
});