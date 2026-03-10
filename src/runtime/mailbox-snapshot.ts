/**
 * Mailbox Snapshot Integration
 * Simple helper for mailbox snapshot in agent requests
 */
import type { Mailbox, MailboxMessage } from '../server/mailbox.js';

export interface MailboxSnapshotEntry {
  id: string;
  seq: number;
  sourceType?: string;
  category?: string;
  priority?: number;
  channel?: string;
  threadId?: string;
  sender?: string;
  shortDescription: string;
  createdAt: string;
}

export interface MailboxSnapshot {
  currentSeq: number;
  entries: MailboxSnapshotEntry[];
  hasUnread: boolean;
  /** Last seq that was already notified to model */
  lastNotifiedSeq?: number;
}

export function buildMailboxSnapshot(
  mailbox: Mailbox,
  sessionId?: string,
  lastSeenSeq: number = 0,
  lastNotifiedSeq: number = 0
): MailboxSnapshot {
  const currentSeq = mailbox.getCurrentSeq();
  const delta = mailbox.listDelta(lastSeenSeq, { sessionId });

  const entries: MailboxSnapshotEntry[] = delta.map(msg => ({
    id: msg.id,
    seq: msg.seq,
    sourceType: msg.sourceType,
    category: msg.category,
    priority: msg.priority,
    channel: msg.channel,
    threadId: msg.threadId,
    sender: msg.sender,
    shortDescription: extractShortDescription(msg),
    createdAt: msg.createdAt,
  }));

  return {
    currentSeq,
    entries,
    hasUnread: entries.length > 0,
    lastNotifiedSeq,
  };
}

/** Check if there are new unread messages since last notified */
export function hasNewUnreadSinceLastNotified(snapshot: MailboxSnapshot): boolean {
  if (!snapshot.hasUnread) return false;
  const lastNotified = snapshot.lastNotifiedSeq ?? 0;
  const maxSeqInSnapshot = snapshot.entries.length > 0 ? Math.max(...snapshot.entries.map(e => e.seq)) : 0;
  return maxSeqInSnapshot > lastNotified;
}

/** Get only new unread entries since last notified */
export function getNewUnreadEntries(snapshot: MailboxSnapshot): MailboxSnapshotEntry[] {
  const lastNotified = snapshot.lastNotifiedSeq ?? 0;
  return snapshot.entries.filter(e => e.seq > lastNotified);
}

function extractShortDescription(msg: MailboxMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content.slice(0, 100);
  }
  if (msg.category === 'notification') return 'New notification';
  if (msg.category === 'alert') return 'New alert';
  if (msg.category === 'task-result') return 'Task result available';
  return 'New message';
}
