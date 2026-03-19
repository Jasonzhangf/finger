import fs from 'fs';
import { BaseBlock, type BlockCapabilities } from '../../core/block.js';

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
  readAt?: string;
  ackAt?: string;
}

export class MailboxBlock extends BaseBlock {
  readonly type = 'mailbox';
  readonly capabilities: BlockCapabilities = {
    functions: ['append', 'list', 'read', 'ack', 'create', 'get', 'updateStatus', 'markRead', 'markAck'],
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
        return this.ack(args.id as string);
      case 'updateStatus':
        return this.updateStatus(
          args.id as string,
          args.status as MailboxMessage['status'],
          args.result,
          args.error as string | undefined
        );
      case 'markRead':
        return this.markRead(args.id as string);
      case 'markAck':
        return this.markAck(args.id as string);
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

    messages.sort((a, b) => b.seq - a.seq);

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

  ack(id: string): { acked: boolean } {
    const msg = this.messages.get(id);
    if (!msg) return { acked: false };

    msg.ackAt = new Date().toISOString();
    msg.updatedAt = msg.ackAt;
    this.notifySubscribers(id, msg);
    this.saveToStorage();
    return { acked: true };
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

  markRead(id: string): { read: boolean } {
    const msg = this.messages.get(id);
    if (!msg) return { read: false };

    msg.readAt = new Date().toISOString();
    msg.updatedAt = msg.readAt;
    this.notifySubscribers(id, msg);
    this.saveToStorage();
    return { read: true };
  }

  markAck(id: string): { acked: boolean } {
    return this.ack(id);
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
            console.error(`[MailboxBlock] Failed to parse line: ${line}`, e);
          }
        }
        console.log(`[MailboxBlock] Loaded ${this.messages.size} messages from ${this.storagePath}`);
      }
    } catch (e) {
      console.error(`[MailboxBlock] Failed to load from storage: ${this.storagePath}`, e);
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
      console.error(`[MailboxBlock] Failed to save to storage: ${this.storagePath}`, e);
    }
  }

  private notifySubscribers(messageId: string, message: MailboxMessage): void {
    const callbacks = this.subscribers.get(messageId);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(message);
        } catch (err) {
          console.error('[MailboxBlock] Subscriber error:', err);
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
  limit?: number;
  offset?: number;
}
