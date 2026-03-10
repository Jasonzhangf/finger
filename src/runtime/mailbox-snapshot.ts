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
}

export function buildMailboxSnapshot(
  mailbox: Mailbox,
  sessionId?: string,
  lastSeenSeq: number = 0
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
  };
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
