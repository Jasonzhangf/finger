import { MailboxBlock, type MailboxMessage } from '../../blocks/mailbox-block/index.js';
import type { MailboxAckOptions } from '../../blocks/mailbox-block/protocol.js';
import { logger } from '../../core/logger.js';

export type HeartbeatMailboxMessage = MailboxMessage;
const log = logger.module('HeartbeatMailboxManager');

export class HeartbeatMailboxManager {
  private mailboxes = new Map<string, MailboxBlock>();

  private normalizeAgentId(agentId: string): string {
    const normalized = agentId.trim();
    return normalized.length > 0 ? normalized : 'finger-system-agent';
  }

  private resolveMailbox(agentId: string): MailboxBlock {
    const normalized = this.normalizeAgentId(agentId);
    const cached = this.mailboxes.get(normalized);
    if (cached) return cached;

    // Mailbox is intentionally ephemeral (in-memory only): no storagePath.
    const mailbox = new MailboxBlock(`mailbox-${normalized}`);
    this.mailboxes.set(normalized, mailbox);
    return mailbox;
  }

  private getMailbox(agentId: string): MailboxBlock | undefined {
    const normalized = this.normalizeAgentId(agentId);
    return this.mailboxes.get(normalized);
  }

  private releaseMailboxIfEmpty(agentId: string, mailbox: MailboxBlock): void {
    const normalized = this.normalizeAgentId(agentId);
    const remain = mailbox.list({ target: normalized });
    if (remain.length === 0) {
      this.mailboxes.delete(normalized);
    }
  }

  append(agentId: string, content: unknown, options?: Record<string, unknown>): { id: string; seq: number } {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.resolveMailbox(normalized);
    return mailbox.append(normalized, content, options);
  }

  get(agentId: string, messageId: string): HeartbeatMailboxMessage | undefined {
    const mailbox = this.getMailbox(agentId);
    if (!mailbox) return undefined;
    return mailbox.get(messageId);
  }

  list(agentId: string, options?: {
    status?: MailboxMessage['status'];
    sessionId?: string;
    channel?: string;
    category?: string;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
    ids?: string[];
  }): HeartbeatMailboxMessage[] {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.getMailbox(normalized);
    if (!mailbox) return [];
    return mailbox.list({ target: normalized, ...options });
  }

  listPending(agentId: string): HeartbeatMailboxMessage[] {
    return this.list(agentId, { status: 'pending' });
  }

  updateStatus(agentId: string, messageId: string, status: MailboxMessage['status'], result?: unknown, error?: string): boolean {
    const mailbox = this.getMailbox(agentId);
    if (!mailbox) return false;
    return mailbox.updateStatus(messageId, status, result, error).updated;
  }

  markRead(agentId: string, messageId: string): { read: boolean; updated?: HeartbeatMailboxMessage } {
    const mailbox = this.getMailbox(agentId);
    if (!mailbox) return { read: false };
    return mailbox.markRead(messageId);
  }

  markReadAll(agentId: string, options?: {
    status?: MailboxMessage['status'];
    sessionId?: string;
    channel?: string;
    category?: string;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
    ids?: string[];
  }): {
    matched: number;
    changed: number;
    movedToProcessing: number;
    updatedMessages: HeartbeatMailboxMessage[];
  } {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.getMailbox(normalized);
    if (!mailbox) {
      return {
        matched: 0,
        changed: 0,
        movedToProcessing: 0,
        updatedMessages: [],
      };
    }
    return mailbox.markReadAll({ target: normalized, ...options });
  }

  ack(agentId: string, messageId: string, options?: MailboxAckOptions): {
    acked: boolean;
    error?: string;
    updated?: HeartbeatMailboxMessage;
    removed?: boolean;
  } {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.getMailbox(normalized);
    if (!mailbox) return { acked: false };
    const ackResult = mailbox.ack(messageId, options);
    if (!ackResult.acked || !ackResult.updated) {
      return ackResult;
    }

    const removed = mailbox.remove(messageId);
    if (!removed.removed) {
      log.warn('Acked mailbox message could not be auto-removed', {
        agentId: normalized,
        messageId,
      });
    }
    this.releaseMailboxIfEmpty(normalized, mailbox);

    return {
      ...ackResult,
      removed: removed.removed,
    };
  }

  remove(agentId: string, messageId: string): { removed: boolean; removedId?: string } {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.getMailbox(normalized);
    if (!mailbox) return { removed: false };
    const result = mailbox.remove(messageId);
    this.releaseMailboxIfEmpty(normalized, mailbox);
    return result;
  }

  removeAll(agentId: string, options?: {
    status?: MailboxMessage['status'];
    sessionId?: string;
    channel?: string;
    category?: string;
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
    ids?: string[];
  }): {
    matched: number;
    removed: number;
    removedIds: string[];
  } {
    const normalized = this.normalizeAgentId(agentId);
    const mailbox = this.getMailbox(normalized);
    if (!mailbox) {
      return {
        matched: 0,
        removed: 0,
        removedIds: [],
      };
    }
    const result = mailbox.removeAll({ target: normalized, ...options });
    this.releaseMailboxIfEmpty(normalized, mailbox);
    return result;
  }
}

export const heartbeatMailbox = new HeartbeatMailboxManager();
