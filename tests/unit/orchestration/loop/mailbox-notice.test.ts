import { describe, it, expect, beforeEach } from 'vitest';
import type { MailboxSnapshot } from '../../../../src/runtime/mailbox-snapshot.js';
import { NoticeHandler, type PendingNotice } from '../../../../src/orchestration/loop/mailbox-notice.js';

describe('NoticeHandler', () => {
  let handler: NoticeHandler;

  beforeEach(() => {
    handler = new NoticeHandler();
  });

  describe('checkMailbox', () => {
    it('should return null when no new messages', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 0,
        entries: [],
        hasUnread: false,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice).toBeNull();
    });

    it('should create pending notice for new messages', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{
          id: 'msg-1',
          seq: 1,
          shortDescription: 'New notification',
          createdAt: '2024-01-01T00:00:00Z',
          category: 'notification',
        }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice).not.toBeNull();
      expect(notice?.type).toBe('mailbox');
      expect(notice?.details.newEntriesCount).toBe(1);
    });

    it('should not create duplicate notices for same messages', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ id: 'msg-1', seq: 1, shortDescription: 'Test', createdAt: '2024-01-01T00:00:00Z' }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };

      const notice1 = handler.checkMailbox(snapshot);
      const notice2 = handler.checkMailbox(snapshot);

      expect(notice1).not.toBeNull();
      expect(notice2).toBeNull();
    });

    it('should group unread categories', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 2,
        entries: [
          { id: 'msg-1', seq: 1, shortDescription: 'Alert', createdAt: '2024-01-01T00:00:00Z', category: 'alert' },
          { id: 'msg-2', seq: 2, shortDescription: 'Info', createdAt: '2024-01-01T00:00:01Z', category: 'info' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice?.details.unreadCategories).toContain('alert');
      expect(notice?.details.unreadCategories).toContain('info');
    });

    it('should set high priority (0) for alerts', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ 
          id: 'msg-1', 
          seq: 1, 
          shortDescription: 'Critical alert', 
          createdAt: '2024-01-01T00:00:00Z',
          category: 'alert',
        }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice?.priority).toBe(0); // Highest priority
    });

    it('should set medium priority (1) for task results', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ 
          id: 'msg-1', 
          seq: 1, 
          shortDescription: 'Task completed', 
          createdAt: '2024-01-01T00:00:00Z',
          category: 'task-result',
        }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice?.priority).toBe(1); // Medium priority
    });

    it('should set low priority (2) for notifications', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ 
          id: 'msg-1', 
          seq: 1, 
          shortDescription: 'New notification', 
          createdAt: '2024-01-01T00:00:00Z',
          category: 'notification',
        }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot);

      expect(notice?.priority).toBe(2); // Low priority
    });
  });

  describe('createInputNotice', () => {
    it('should create user input notice', () => {
      const notice = handler.createInputNotice('Choose option', ['A', 'B']);

      expect(notice.type).toBe('user_input');
      expect(notice.priority).toBe(0); // Highest
      expect(notice.details.question).toBe('Choose option');
      expect(notice.details.options).toEqual(['A', 'B']);
    });

    it('should generate unique IDs for each notice', () => {
      const notice1 = handler.createInputNotice('Question 1');
      const notice2 = handler.createInputNotice('Question 2');

      expect(notice1.id).not.toBe(notice2.id);
    });

    it('should support question without options', () => {
      const notice = handler.createInputNotice('Enter your name');

      expect(notice.details.question).toBe('Enter your name');
      expect(notice.details.options).toBeUndefined();
    });
  });

  describe('getPendingNotices', () => {
    it('should return notices ordered by priority', () => {
      handler.createInputNotice('low priority test');
      
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ 
          id: 'msg-1', 
          seq: 1, 
          shortDescription: 'Task', 
          createdAt: '2024-01-01T00:00:00Z',
          category: 'task-result',
        }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      handler.checkMailbox(snapshot);
      
      handler.createInputNotice('high priority test');

      const notices = handler.getPendingNotices();

      expect(notices.length).toBeGreaterThanOrEqual(2);
      // First should be priority 0 (user_input)
      expect(notices[0].priority).toBe(0);
    });

    it('should return empty array when no notices', () => {
      const notices = handler.getPendingNotices();
      expect(notices).toHaveLength(0);
    });
  });

  describe('dismissNotice', () => {
    it('should remove pending notice', () => {
      const notice = handler.createInputNotice('Test question');
      const dismissed = handler.dismissNotice(notice.id);

      expect(dismissed).toBe(true);
      expect(handler.getPendingNotices()).toHaveLength(0);
    });

    it('should return false for non-existent notice', () => {
      const dismissed = handler.dismissNotice('non-existent');
      expect(dismissed).toBe(false);
    });
  });

  describe('clearAllNotices', () => {
    it('should remove all pending notices', () => {
      handler.createInputNotice('Q1');
      handler.createInputNotice('Q2');
      handler.createInputNotice('Q3');

      expect(handler.getPendingNotices()).toHaveLength(3);

      handler.clearAllNotices();

      expect(handler.getPendingNotices()).toHaveLength(0);
    });
  });

  describe('markAsNotified', () => {
    it('should update lastNotifiedSeq for mailbox notice', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ id: 'msg-1', seq: 1, shortDescription: 'Test', createdAt: '2024-01-01T00:00:00Z' }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      const notice = handler.checkMailbox(snapshot)!;

      handler.markAsNotified(notice.id);
      const state = handler.getTrackingState();

      expect(state.lastNotifiedSeq).toBe(1);
    });

    it('should not crash for non-mailbox notice', () => {
      const notice = handler.createInputNotice('Test');
      expect(() => handler.markAsNotified(notice.id)).not.toThrow();
    });
  });

  describe('getTrackingState', () => {
    it('should return current tracking state', () => {
      const snapshot: MailboxSnapshot = {
        currentSeq: 1,
        entries: [{ id: 'msg-1', seq: 1, shortDescription: 'Test', createdAt: '2024-01-01T00:00:00Z' }],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };
      handler.checkMailbox(snapshot);

      const state = handler.getTrackingState();

      expect(state.lastCheckedSeq).toBe(1);
      expect(state.lastNotifiedSeq).toBe(0); // Not yet notified
    });
  });

  describe('integration scenario', () => {
    it('should handle full workflow: messages -> check -> notify -> dismiss', () => {
      // Phase 1: Check mailbox with messages
      const snapshot1: MailboxSnapshot = {
        currentSeq: 2,
        entries: [
          { id: 'msg-1', seq: 1, shortDescription: 'Notification', createdAt: '2024-01-01T00:00:00Z', category: 'notification' },
          { id: 'msg-2', seq: 2, shortDescription: 'Alert', createdAt: '2024-01-01T00:00:01Z', category: 'alert' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 0,
      };

      const notice = handler.checkMailbox(snapshot1);

      expect(notice).not.toBeNull();
      expect(handler.getPendingNotices()).toHaveLength(1);

      // Phase 2: User handles notice
      handler.markAsNotified(notice!.id);
      let state = handler.getTrackingState();
      expect(state.lastNotifiedSeq).toBe(2);

      // Phase 3: Dismiss notice
      handler.dismissNotice(notice!.id);
      expect(handler.getPendingNotices()).toHaveLength(0);

      // Phase 4: Check again with new messages, should create new notice
      const snapshot2: MailboxSnapshot = {
        currentSeq: 3,
        entries: [
          { id: 'msg-3', seq: 3, shortDescription: 'New message', createdAt: '2024-01-01T00:00:02Z' },
        ],
        hasUnread: true,
        lastNotifiedSeq: 2,
      };

      const notice2 = handler.checkMailbox(snapshot2);

      expect(notice2).not.toBeNull();
      expect(handler.getPendingNotices()).toHaveLength(1);
    });
  });
});
