import path from 'path';
import { MailboxBlock, type MailboxMessage } from '../../blocks/mailbox-block/index.js';
import { ensureDir, FINGER_PATHS } from '../../core/finger-paths.js';

export type HeartbeatMailboxMessage = MailboxMessage;

export class HeartbeatMailboxManager {
  private mailboxes = new Map<string, MailboxBlock>();

  private resolveMailbox(agentId: string): MailboxBlock {
    const normalized = agentId.trim();
    const cached = this.mailboxes.get(normalized);
    if (cached) return cached;

    const dir = ensureDir(path.join(FINGER_PATHS.home, 'mailbox', normalized));
    const storagePath = path.join(dir, 'inbox.jsonl');
    const mailbox = new MailboxBlock(`mailbox-${normalized}`, storagePath);
    this.mailboxes.set(normalized, mailbox);
    return mailbox;
  }

  append(agentId: string, content: unknown, options?: Record<string, unknown>): { id: string; seq: number } {
    const mailbox = this.resolveMailbox(agentId);
    return mailbox.append(agentId, content, options);
  }

  listPending(agentId: string): HeartbeatMailboxMessage[] {
    const mailbox = this.resolveMailbox(agentId);
    return mailbox.list({ target: agentId, status: 'pending' });
  }

  updateStatus(agentId: string, messageId: string, status: MailboxMessage['status'], result?: unknown, error?: string): boolean {
    const mailbox = this.resolveMailbox(agentId);
    return mailbox.updateStatus(messageId, status, result, error).updated;
  }

  markRead(agentId: string, messageId: string): boolean {
    const mailbox = this.resolveMailbox(agentId);
    return mailbox.markRead(messageId).read;
  }
}

export const heartbeatMailbox = new HeartbeatMailboxManager();
