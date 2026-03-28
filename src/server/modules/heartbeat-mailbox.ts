import fs from 'fs';
import path from 'path';
import type { MailboxMessage } from '../../blocks/mailbox-block/index.js';
import {
  applyMailboxAckTransition,
  applyMailboxReadTransition,
  type MailboxAckOptions,
} from '../../blocks/mailbox-block/protocol.js';
import { FINGER_HOME } from '../../core/finger-paths.js';
import { withFileMutexSync } from '../../core/file-mutex.js';
import { logger } from '../../core/logger.js';

export type HeartbeatMailboxMessage = MailboxMessage;
const log = logger.module('HeartbeatMailboxManager');

interface MailboxListOptions {
  status?: MailboxMessage['status'];
  sessionId?: string;
  channel?: string;
  category?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  ids?: string[];
}

export class HeartbeatMailboxManager {
  private normalizeAgentId(agentId: string): string {
    const normalized = agentId.trim();
    return normalized.length > 0 ? normalized : 'finger-system-agent';
  }

  private resolveMailboxPath(agentId: string): string {
    const normalized = this.normalizeAgentId(agentId);
    return path.join(FINGER_HOME, 'mailbox', normalized, 'inbox.jsonl');
  }

  private resolveMailboxLockPath(agentId: string): string {
    return `${this.resolveMailboxPath(agentId)}.lock`;
  }

  private readMessages(agentId: string): HeartbeatMailboxMessage[] {
    const mailboxPath = this.resolveMailboxPath(agentId);
    try {
      if (!fs.existsSync(mailboxPath)) return [];
      const content = fs.readFileSync(mailboxPath, 'utf-8');
      if (content.trim().length === 0) return [];
      return content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as HeartbeatMailboxMessage);
    } catch (error) {
      log.error('Failed to read mailbox file', error instanceof Error ? error : undefined, { agentId, mailboxPath });
      return [];
    }
  }

  private writeMessages(agentId: string, messages: HeartbeatMailboxMessage[]): void {
    const mailboxPath = this.resolveMailboxPath(agentId);
    try {
      fs.mkdirSync(path.dirname(mailboxPath), { recursive: true });
      const payload = messages.length > 0
        ? messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
        : '';
      fs.writeFileSync(mailboxPath, payload, 'utf-8');
    } catch (error) {
      log.error('Failed to write mailbox file', error instanceof Error ? error : undefined, { agentId, mailboxPath });
      throw error;
    }
  }

  private filterMessages(
    agentId: string,
    messages: HeartbeatMailboxMessage[],
    options?: MailboxListOptions,
  ): HeartbeatMailboxMessage[] {
    const normalized = this.normalizeAgentId(agentId);
    let filtered = messages.filter((message) => message.target === normalized);

    if (options?.status) {
      filtered = filtered.filter((message) => message.status === options.status);
    }
    if (options?.sessionId) {
      filtered = filtered.filter((message) => message.sessionId === options.sessionId);
    }
    if (options?.channel) {
      filtered = filtered.filter((message) => message.channel === options.channel);
    }
    if (options?.category) {
      filtered = filtered.filter((message) => message.category === options.category);
    }
    if (options?.unreadOnly) {
      filtered = filtered.filter((message) => !message.readAt);
    }
    if (Array.isArray(options?.ids) && options.ids.length > 0) {
      const allowedIds = new Set(options.ids);
      filtered = filtered.filter((message) => allowedIds.has(message.id));
    }

    filtered.sort((a, b) => {
      const aPriority = typeof a.priority === 'number' ? a.priority : 2;
      const bPriority = typeof b.priority === 'number' ? b.priority : 2;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.seq - a.seq;
    });

    if (options?.offset && options.offset > 0) {
      filtered = filtered.slice(options.offset);
    }
    if (options?.limit && options.limit > 0) {
      filtered = filtered.slice(0, options.limit);
    }
    return filtered;
  }

  private nextSeq(messages: HeartbeatMailboxMessage[]): number {
    let maxSeq = 0;
    for (const message of messages) {
      if (message.seq > maxSeq) maxSeq = message.seq;
    }
    return maxSeq + 1;
  }

  append(agentId: string, content: unknown, options?: Record<string, unknown>): { id: string; seq: number } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const seq = this.nextSeq(messages);
      const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const message: HeartbeatMailboxMessage = {
        id,
        seq,
        target: normalized,
        content,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        sender: typeof options?.sender === 'string' ? options.sender : undefined,
        callbackId: typeof options?.callbackId === 'string' ? options.callbackId : undefined,
        sessionId: typeof options?.sessionId === 'string' ? options.sessionId : undefined,
        runtimeSessionId: typeof options?.runtimeSessionId === 'string' ? options.runtimeSessionId : undefined,
        channel: typeof options?.channel === 'string' ? options.channel : undefined,
        accountId: typeof options?.accountId === 'string' ? options.accountId : undefined,
        threadId: typeof options?.threadId === 'string' ? options.threadId : undefined,
        sourceType: options?.sourceType as HeartbeatMailboxMessage['sourceType'],
        category: typeof options?.category === 'string' ? options.category : undefined,
        priority: options?.priority as HeartbeatMailboxMessage['priority'],
        deliveryPolicy: options?.deliveryPolicy as HeartbeatMailboxMessage['deliveryPolicy'],
      };

      messages.push(message);
      this.writeMessages(normalized, messages);
      return { id, seq };
    });
  }

  get(agentId: string, messageId: string): HeartbeatMailboxMessage | undefined {
    const normalized = this.normalizeAgentId(agentId);
    const messages = this.readMessages(normalized);
    return messages.find((message) => message.id === messageId);
  }

  list(agentId: string, options?: MailboxListOptions): HeartbeatMailboxMessage[] {
    const normalized = this.normalizeAgentId(agentId);
    const messages = this.readMessages(normalized);
    return this.filterMessages(normalized, messages, options);
  }

  listPending(agentId: string): HeartbeatMailboxMessage[] {
    return this.list(agentId, { status: 'pending' });
  }

  updateStatus(
    agentId: string,
    messageId: string,
    status: MailboxMessage['status'],
    result?: unknown,
    error?: string,
  ): boolean {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return false;

      const current = messages[index];
      const updated: HeartbeatMailboxMessage = {
        ...current,
        status,
        updatedAt: new Date().toISOString(),
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      };
      messages[index] = updated;
      this.writeMessages(normalized, messages);
      return true;
    });
  }

  markRead(agentId: string, messageId: string): { read: boolean; updated?: HeartbeatMailboxMessage } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return { read: false };

      const transitioned = applyMailboxReadTransition(messages[index]);
      messages[index] = transitioned.message;
      this.writeMessages(normalized, messages);
      return { read: true, updated: transitioned.message };
    });
  }

  markReadAll(agentId: string, options?: MailboxListOptions): {
    matched: number;
    changed: number;
    movedToProcessing: number;
    updatedMessages: HeartbeatMailboxMessage[];
  } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const selected = this.filterMessages(normalized, messages, options);
      if (selected.length === 0) {
        return {
          matched: 0,
          changed: 0,
          movedToProcessing: 0,
          updatedMessages: [],
        };
      }

      let changed = 0;
      let movedToProcessing = 0;
      const updatedMessages: HeartbeatMailboxMessage[] = [];
      const byId = new Map(messages.map((message, index) => [message.id, index] as const));

      for (const item of selected) {
        const index = byId.get(item.id);
        if (index === undefined) continue;
        const transitioned = applyMailboxReadTransition(messages[index]);
        updatedMessages.push(transitioned.message);
        if (!transitioned.changed) continue;
        changed += 1;
        if (transitioned.movedToProcessing) movedToProcessing += 1;
        messages[index] = transitioned.message;
      }

      if (changed > 0) {
        this.writeMessages(normalized, messages);
      }

      return {
        matched: selected.length,
        changed,
        movedToProcessing,
        updatedMessages,
      };
    });
  }

  ack(agentId: string, messageId: string, options?: MailboxAckOptions): {
    acked: boolean;
    error?: string;
    updated?: HeartbeatMailboxMessage;
    removed?: boolean;
  } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return { acked: false };

      const transitioned = applyMailboxAckTransition(messages[index], options);
      if (!transitioned.ok || !transitioned.message) {
        return { acked: false, error: transitioned.error };
      }

      // ACK 后自动移除，保持与现有行为一致
      messages.splice(index, 1);
      this.writeMessages(normalized, messages);

      return {
        acked: true,
        updated: transitioned.message,
        removed: true,
      };
    });
  }

  remove(agentId: string, messageId: string): { removed: boolean; removedId?: string } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const index = messages.findIndex((message) => message.id === messageId);
      if (index < 0) return { removed: false };
      messages.splice(index, 1);
      this.writeMessages(normalized, messages);
      return { removed: true, removedId: messageId };
    });
  }

  removeAll(agentId: string, options?: MailboxListOptions): {
    matched: number;
    removed: number;
    removedIds: string[];
  } {
    const normalized = this.normalizeAgentId(agentId);
    return withFileMutexSync(this.resolveMailboxLockPath(normalized), () => {
      const messages = this.readMessages(normalized);
      const selected = this.filterMessages(normalized, messages, options);
      if (selected.length === 0) {
        return {
          matched: 0,
          removed: 0,
          removedIds: [],
        };
      }

      const removeSet = new Set(selected.map((message) => message.id));
      const remaining = messages.filter((message) => !removeSet.has(message.id));
      this.writeMessages(normalized, remaining);

      return {
        matched: selected.length,
        removed: selected.length,
        removedIds: selected.map((message) => message.id),
      };
    });
  }
}

export const heartbeatMailbox = new HeartbeatMailboxManager();
