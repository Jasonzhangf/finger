import fs from 'fs';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';
import {
  applyMailboxAckTransition,
  applyMailboxReadTransition,
  type MailboxAckOptions,
} from './protocol.js';

const clog = createConsoleLikeLogger('Index');

export interface MailboxMessage {
  id: string;
  seq: number;
  target: string;
  content: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  sender?: string;
  callbackId?: string;
  sessionId?: string;
  runtimeSessionId?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
  sourceType?: 'control' | 'observe' | 'agent-callable';
  category?: string;
  priority?: 0 | 1 | 2 | 3;
  deliveryPolicy?: 'realtime' | 'batched' | 'passive';
  readAt?: string;
  ackAt?: string;
}

const log = logger.module('MailboxBlock');

export class MailboxBlock extends BaseBlock {
  readonly type = 'mailbox';
  readonly capabilities: BlockCapabilities = {
    functions: ['append', 'list', 'read', 'ack', 'create', 'get', 'updateStatus', 'markRead', 'markReadAll', 'markAck', 'remove', 'removeAll'],
    cli: [
      { name: 'append', description: 'Append message to mailbox', args: [] },
      { name: 'list', description: 'List messages', args: [] },
      { name: 'read', description: 'Read message by ID', args: [] },
      { name: 'ack', description: 'Acknowledge message', args: [] }
    ],
    stateSchema: {
      messageCount: { type: 'number', readonly: true, description: 'Total messages' },
      currentSeq: { type: 'number', readonly: true, description: 'Current sequence number' }
    },
    events: ['message:appended', 'message:updated', 'message:acked']
  };

  private messages: Map<string, MailboxMessage> = new Map();
  private nextSeq: number = 1;
  private subscribers: Map<string, Set<(msg: MailboxMessage) => void>> = new Map();
  private callbackIndex: Map<string, string> = new Map();
  private seqIndex: Map<number, string> = new Map();
  private storagePath?: string;

  constructor(id: string, storagePath?: string) {
    super(id, 'mailbox');
    this.storagePath = storagePath;
    if (storagePath) {
      this.loadFromStorage();
    }
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'append':
      case 'create':
        return this.append(
          args.target as string,
          args.content,
          args.options as Record<string, unknown> | undefined
        );
      case 'list':
        return this.list(args as ListOptions);
      case 'read':
      case 'get':
        return this.get(args.id as string);
      case 'ack':
        return this.ack(args.id as string, {
          status: args.status as 'completed' | 'failed' | undefined,
          result: args.result,
          error: args.error as string | undefined,
        });
      case 'updateStatus':
        return this.updateStatus(
          args.id as string,
          args.status as MailboxMessage['status'],
          args.result,
          args.error as string | undefined
        );
      case 'markRead':
        return this.markRead(args.id as string);
      case 'markReadAll':
        return this.markReadAll(args as BatchMailboxOptions);
      case 'markAck':
        return this.markAck(args.id as string);
      case 'remove':
        return this.remove(args.id as string);
      case 'removeAll':
        return this.removeAll(args as BatchMailboxOptions);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  append(target: string, content: unknown, options?: Record<string, unknown>): { id: string; seq: number } {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seq = this.nextSeq++;
    const now = new Date().toISOString();

    const message: MailboxMessage = {
      id,
      seq,
      target,
      content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      sender: options?.sender as string | undefined,
      callbackId: options?.callbackId as string | undefined,
      sessionId: options?.sessionId as string | undefined,
      runtimeSessionId: options?.runtimeSessionId as string | undefined,
      channel: options?.channel as string | undefined,
      accountId: options?.accountId as string | undefined,
      threadId: options?.threadId as string | undefined,
      sourceType: options?.sourceType as MailboxMessage['sourceType'],
      category: options?.category as string | undefined,
      priority: options?.priority as MailboxMessage['priority'],
      deliveryPolicy: options?.deliveryPolicy as MailboxMessage['deliveryPolicy'],
    };

    this.messages.set(id, message);
    this.seqIndex.set(seq, id);
    if (message.callbackId) {
      this.callbackIndex.set(message.callbackId, id);
    }

    this.updateState({
      data: {
        messageCount: this.messages.size,
        currentSeq: this.nextSeq - 1,
        lastAppended: id
      }
    });

    this.notifySubscribers(id, message);
    this.saveToStorage();

    return { id, seq };
  }

  list(options?: ListOptions): MailboxMessage[] {
    let messages = Array.from(this.messages.values());

    if (options?.target) {
      messages = messages.filter(m => m.target === options.target);
    }
    if (options?.status) {
      messages = messages.filter(m => m.status === options.status);
    }
    if (options?.sessionId) {
      messages = messages.filter(m => m.sessionId === options.sessionId);
    }
    if (options?.channel) {
      messages = messages.filter(m => m.channel === options.channel);
    }
    if (options?.category) {
      messages = messages.filter(m => m.category === options.category);
    }
    if (options?.unreadOnly) {
      messages = messages.filter(m => !m.readAt);
    }
    if (Array.isArray(options?.ids) && options.ids.length > 0) {
      const allowedIds = new Set(options.ids);
      messages = messages.filter(m => allowedIds.has(m.id));
    }

    messages.sort((a, b) => {
      const aPriority = typeof a.priority === 'number' ? a.priority : 2;
      const bPriority = typeof b.priority === 'number' ? b.priority : 2;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }
      return b.seq - a.seq;
    });

    if (options?.limit) {
      messages = messages.slice(0, options.limit);
    }
    if (options?.offset) {
      messages = messages.slice(options.offset);
    }

    return messages;
  }

  get(id: string): MailboxMessage | undefined {
    return this.messages.get(id);
  }

  ack(id: string, options?: MailboxAckOptions): { acked: boolean; error?: string; updated?: MailboxMessage } {
    const msg = this.messages.get(id);
    if (!msg) return { acked: false };

    const transitioned = applyMailboxAckTransition(msg, options);
    if (!transitioned.ok || !transitioned.message) {
      return { acked: false, error: transitioned.error };
    }

    this.messages.set(id, transitioned.message);
    this.notifySubscribers(id, transitioned.message);
    this.saveToStorage();
    return { acked: true, updated: transitioned.message };
  }

  updateStatus(id: string, status: MailboxMessage['status'], result?: unknown, error?: string): { updated: boolean } {
    const msg = this.messages.get(id);
    if (!msg) return { updated: false };

    msg.status = status;
    msg.updatedAt = new Date().toISOString();
    if (result !== undefined) msg.result = result;
    if (error !== undefined) msg.error = error;

    this.notifySubscribers(id, msg);
    this.saveToStorage();
    return { updated: true };
  }

  markRead(id: string): { read: boolean; updated?: MailboxMessage } {
    const msg = this.messages.get(id);
    if (!msg) return { read: false };

    const transitioned = applyMailboxReadTransition(msg);
    this.messages.set(id, transitioned.message);
    this.notifySubscribers(id, transitioned.message);
    this.saveToStorage();
    return { read: true, updated: transitioned.message };
  }

  markAck(id: string, options?: MailboxAckOptions): { acked: boolean; error?: string; updated?: MailboxMessage } {
    return this.ack(id, options);
  }

  remove(id: string): { removed: boolean; removedId?: string } {
    const msg = this.messages.get(id);
    if (!msg) {
      return { removed: false };
    }

    this.messages.delete(id);
    this.seqIndex.delete(msg.seq);
    if (msg.callbackId) {
      this.callbackIndex.delete(msg.callbackId);
    }
    this.updateState({
      data: {
        messageCount: this.messages.size,
        currentSeq: this.nextSeq - 1,
      }
    });
    this.saveToStorage();
    return { removed: true, removedId: id };
  }

  markReadAll(options?: BatchMailboxOptions): {
    matched: number;
    changed: number;
    movedToProcessing: number;
    updatedMessages: MailboxMessage[];
  } {
    const selected = this.list(options);
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
    const updatedMessages: MailboxMessage[] = [];

    for (const message of selected) {
      const transitioned = applyMailboxReadTransition(message);
      updatedMessages.push(transitioned.message);
      if (!transitioned.changed) continue;
      changed += 1;
      if (transitioned.movedToProcessing) {
        movedToProcessing += 1;
      }
      this.messages.set(message.id, transitioned.message);
      this.notifySubscribers(message.id, transitioned.message);
    }

    if (changed > 0) {
      this.saveToStorage();
    }

    return {
      matched: selected.length,
      changed,
      movedToProcessing,
      updatedMessages,
    };
  }

  removeAll(options?: BatchMailboxOptions): {
    matched: number;
    removed: number;
    removedIds: string[];
  } {
    const selected = this.list(options);
    if (selected.length === 0) {
      return {
        matched: 0,
        removed: 0,
        removedIds: [],
      };
    }

    const removedIds: string[] = [];
    for (const message of selected) {
      if (!this.messages.delete(message.id)) continue;
      this.seqIndex.delete(message.seq);
      if (message.callbackId) {
        this.callbackIndex.delete(message.callbackId);
      }
      removedIds.push(message.id);
    }

    if (removedIds.length > 0) {
      this.updateState({
        data: {
          messageCount: this.messages.size,
          currentSeq: this.nextSeq - 1,
        }
      });
      this.saveToStorage();
    }

    return {
      matched: selected.length,
      removed: removedIds.length,
      removedIds,
    };
  }

  private loadFromStorage(): void {
    if (!this.storagePath) return;

    try {
      if (fs.existsSync(this.storagePath)) {
        const content = fs.readFileSync(this.storagePath, 'utf-8');
        const lines = content.trim().split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as MailboxMessage;
            this.messages.set(msg.id, msg);
            this.seqIndex.set(msg.seq, msg.id);
            if (msg.callbackId) {
              this.callbackIndex.set(msg.callbackId, msg.id);
            }
            if (msg.seq >= this.nextSeq) {
              this.nextSeq = msg.seq + 1;
            }
          } catch (e) {
            log.error('Failed to parse line: ${line}', e instanceof Error ? e : undefined, { "line": line });
          }
        }
        clog.log(`[MailboxBlock] Loaded ${this.messages.size} messages from ${this.storagePath}`);
      }
    } catch (e) {
      log.error('Failed to load from storage: ${this.storagePath}', e instanceof Error ? e : undefined, { "this.storagePath": this.storagePath });
    }
  }

  private saveToStorage(): void {
    if (!this.storagePath) return;

    try {
      const lines: string[] = [];
      for (const msg of this.messages.values()) {
        lines.push(JSON.stringify(msg));
      }
      fs.writeFileSync(this.storagePath, lines.join('\n') + '\n', 'utf-8');
    } catch (e) {
      log.error('Failed to save to storage: ${this.storagePath}', e instanceof Error ? e : undefined, { "this.storagePath": this.storagePath });
    }
  }

  private notifySubscribers(messageId: string, message: MailboxMessage): void {
    const callbacks = this.subscribers.get(messageId);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(message);
        } catch (err) {
          clog.error('[MailboxBlock] Subscriber error:', err);
        }
      }
    }
  }

  subscribe(messageId: string, callback: (msg: MailboxMessage) => void): () => void {
    if (!this.subscribers.has(messageId)) {
      this.subscribers.set(messageId, new Set());
    }
    this.subscribers.get(messageId)!.add(callback);

    const msg = this.messages.get(messageId);
    if (msg) callback(msg);

    return () => {
      this.subscribers.get(messageId)?.delete(callback);
    };
  }
}

interface ListOptions {
  target?: string;
  status?: MailboxMessage['status'];
  sessionId?: string;
  channel?: string;
  category?: string;
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  ids?: string[];
}

type BatchMailboxOptions = ListOptions;
