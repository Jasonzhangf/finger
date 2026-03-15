import { describe, it, expect, beforeEach } from 'vitest';
import { Mailbox } from '../../../src/server/mailbox.js';
import { buildMailboxSnapshot, hasNewUnreadSinceLastNotified, getNewUnreadEntries, type MailboxSnapshot } from '../../../src/runtime/mailbox-snapshot.js';

describe('MailboxSnapshot', () => {
  let mailbox: Mailbox;

  beforeEach(() => {
    mailbox = new Mailbox();
  });

  describe('buildMailboxSnapshot', () => {
    it('should build empty snapshot for new mailbox', () => {
      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 0);

      expect(snapshot.currentSeq).toBe(0);
      expect(snapshot.entries).toHaveLength(0);
      expect(snapshot.hasUnread).toBe(false);
      expect(snapshot.lastNotifiedSeq).toBe(0);
    });

    it('should include new messages since lastSeenSeq', () => {
      mailbox.createMessage('agent-1', { text: 'hello' }, { sessionId: 'session-1', sourceType: 'control' });
      mailbox.createMessage('agent-2', { text: 'world' }, { sessionId: 'session-1', sourceType: 'control' });

      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 0);

      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.hasUnread).toBe(true);
      expect(snapshot.currentSeq).toBe(2);
    });

    it('should only include messages for specified sessionId', () => {
      mailbox.createMessage('agent-1', { text: 'for session-1' }, { sessionId: 'session-1' });
      mailbox.createMessage('agent-2', { text: 'for session-2' }, { sessionId: 'session-2' });
      mailbox.createMessage('agent-3', { text: 'another for session-1' }, { sessionId: 'session-1' });

      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 0);

      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.entries.every(e => e.seq !== 2)).toBe(true); // seq 2 is for session-2
    });

    it('should filter messages by lastSeenSeq', () => {
      mailbox.createMessage('agent-1', { text: 'msg1' }, { sessionId: 'session-1' });
      mailbox.createMessage('agent-2', { text: 'msg2' }, { sessionId: 'session-1' });
      mailbox.createMessage('agent-3', { text: 'msg3' }, { sessionId: 'session-1' });

      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 1, 0);

      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.entries[0].seq).toBe(2);
      expect(snapshot.entries[1].seq).toBe(3);
    });

    it('should preserve message metadata', () => {
      mailbox.createMessage('agent-1', { text: 'test' }, {
        sessionId: 'session-1',
        sourceType: 'control',
        category: 'notification',
        priority: 1,
        channel: 'discord',
        threadId: 'thread-123',
        sender: 'user-1',
      });

      const snapshot = buildMailboxSnapshot(mailbox, 'session-1', 0, 0);
      const entry = snapshot.entries[0];

      expect(entry.sourceType).toBe('control');
      expect(entry.category).toBe('notification');
      expect(entry.priority).toBe(1);
      expect(entry.channel).toBe('discord');
      expect(entry.threadId).toBe('thread-123');
      expect(entry.sender).toBe('user-1');
    });
  });

  describe('hasNewUnreadSinceLastNotified', () => {
    it('should return false when hasUnread is false', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 0,
        entries: [],
        hasUnread: false,
        lastNotifiedSeq: 0,
      };

      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(false);
    });

    it('should return true when maxSeq > lastNotifiedSeq', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 5,
        entries: [
          { id: '1', seq: 5, shortDescription: 'test', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 3,
      };

      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
    });

    it('should return false when maxSeq <= lastNotifiedSeq', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 5,
        entries: [
          { id: '1', seq: 5, shortDescription: 'test', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 5,
      };

      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(false);
    });

    it('should handle undefined lastNotifiedSeq as 0', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [
          { id: '1', seq: 1, shortDescription: 'test', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: undefined,
      };

      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
    });
  });

  describe('getNewUnreadEntries', () => {
    it('should filter entries by seq > lastNotifiedSeq', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 5,
        entries: [
          { id: '1', seq: 3, shortDescription: 'old', createdAt: '2024-01-01' },
          { id: '2', seq: 4, shortDescription: 'new1', createdAt: '2024-01-01' },
          { id: '3', seq: 5, shortDescription: 'new2', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 3,
      };

      const newEntries = getNewUnreadEntries(snapshot);

      expect(newEntries).toHaveLength(2);
      expect(newEntries[0].seq).toBe(4);
      expect(newEntries[1].seq).toBe(5);
    });

    it('should return empty when lastNotifiedSeq >= all seqs', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 5,
        entries: [
          { id: '1', seq: 3, shortDescription: 'old', createdAt: '2024-01-01' },
          { id: '2', seq: 4, shortDescription: 'old2', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 5,
      };

      const newEntries = getNewUnreadEntries(snapshot);

      expect(newEntries).toHaveLength(0);
    });

    it('should handle undefined lastNotifiedSeq', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 5,
        entries: [
          { id: '1', seq: 1, shortDescription: 'new', createdAt: '2024-01-01' },
        ],
        hasUnread: true,
        lastNotifiedSeq: undefined,
      };

      const newEntries = getNewUnreadEntries(snapshot);

      expect(newEntries).toHaveLength(1);
    });
  });

  describe('end-to-end dryrun scenario', () => {
    it('should simulate full lifecycle: append -> snapshot -> notify -> check', () => {
      // Initial state
      let lastSeenSeq = 0;
      let lastNotifiedSeq = 0;

      // Append messages
      const msg1Id = mailbox.createMessage('agent-1', { text: 'msg1' }, { sessionId: 'session-1' });
      const msg2Id = mailbox.createMessage('agent-2', { text: 'msg2' }, { sessionId: 'session-1' });

      // Build snapshot (first notification)
      let snapshot = buildMailboxSnapshot(mailbox, 'session-1', lastSeenSeq, lastNotifiedSeq);

      expect(snapshot.entries).toHaveLength(2);
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
      expect(getNewUnreadEntries(snapshot)).toHaveLength(2);

      // Mark as notified
      lastSeenSeq = snapshot.currentSeq;
      lastNotifiedSeq = snapshot.currentSeq;

      // Append more messages
      mailbox.createMessage('agent-3', { text: 'msg3' }, { sessionId: 'session-1' });
      mailbox.createMessage('agent-4', { text: 'msg4' }, { sessionId: 'session-2' }); // different session

      // Build snapshot (second notification)
      snapshot = buildMailboxSnapshot(mailbox, 'session-1', lastSeenSeq, lastNotifiedSeq);

      // Should only see msg3 (msg4 is for different session)
      expect(snapshot.entries).toHaveLength(1);
      expect(snapshot.entries[0].seq).toBe(3);
      expect(hasNewUnreadSinceLastNotified(snapshot)).toBe(true);
    });
  });
});
