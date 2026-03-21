import { logger } from '../core/logger.js';
/**
 * Mailbox - 消息邮箱系统
 * 存储消息状态，支持异步查询
 */

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
  // 新增：会话绑定
  sessionId?: string;
  runtimeSessionId?: string;
  // 新增：来源渠道
  channel?: string;
  accountId?: string;
  threadId?: string;
  // 新增：分类与优先级
  sourceType?: 'control' | 'observe' | 'agent-callable';
  category?: 'notification' | 'alert' | 'info' | 'task-result';
  priority?: 0 | 1 | 2 | 3; // 0 = highest, 3 = lowest
  // 新增：投递策略
  deliveryPolicy?: 'realtime' | 'batched' | 'passive';
  // 新增：已读/已确认
  readAt?: string;
  ackAt?: string;
}

type CreateMessageOptions = {
  sender?: string;
  callbackId?: string;
  sessionId?: string;
  runtimeSessionId?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
  sourceType?: 'control' | 'observe' | 'agent-callable';
  category?: 'notification' | 'alert' | 'info' | 'task-result';
  priority?: 0 | 1 | 2 | 3;
  deliveryPolicy?: 'realtime' | 'batched' | 'passive';
};

export class Mailbox {
  private messages: Map<string, MailboxMessage> = new Map();
  private nextSeq: number = 1;
  private subscribers: Map<string, Set<(msg: MailboxMessage) => void>> = new Map();
  private callbackIndex: Map<string, string> = new Map(); // callbackId -> messageId
  private seqIndex: Map<number, string> = new Map(); // seq -> messageId

  /**
   * 创建新消息（向后兼容签名）
   */
  createMessage(
    target: string,
    content: unknown,
    senderOrOptions?: string | CreateMessageOptions,
    callbackId?: string
  ): string {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const seq = this.nextSeq++;
    const now = new Date().toISOString();

    // 处理向后兼容的调用方式
    let options: CreateMessageOptions = {};

    if (typeof senderOrOptions === 'string') {
      // 旧签名: (target, content, sender?, callbackId?)
      options = {
        sender: senderOrOptions,
        callbackId: callbackId
      };
    } else if (senderOrOptions) {
      // 新签名: (target, content, options?)
      options = senderOrOptions;
    }

    const message: MailboxMessage = {
      id,
      seq,
      target,
      content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      sender: options.sender,
      callbackId: options.callbackId,
      sessionId: options.sessionId,
      runtimeSessionId: options.runtimeSessionId,
      channel: options.channel,
      accountId: options.accountId,
      threadId: options.threadId,
      sourceType: options.sourceType,
      category: options.category,
      priority: options.priority,
      deliveryPolicy: options.deliveryPolicy,
    };
    this.messages.set(id, message);
    this.seqIndex.set(seq, id);
    if (options.callbackId) {
      this.callbackIndex.set(options.callbackId, id);
    }
    this.notifySubscribers(id, message);
    return id;
  }

  /**
   * 获取消息增量（从某个序号开始）
   */
  listDelta(sinceSeq: number, options?: {
    target?: string;
    sessionId?: string;
    runtimeSessionId?: string;
    status?: MailboxMessage['status'];
    sourceType?: MailboxMessage['sourceType'];
    priority?: MailboxMessage['priority'];
    limit?: number;
  }): MailboxMessage[] {
    let messages = Array.from(this.messages.values())
      .filter(msg => msg.seq > sinceSeq);

    if (options?.target) {
      messages = messages.filter(m => m.target === options.target);
    }
    if (options?.sessionId) {
      messages = messages.filter(m => m.sessionId === options.sessionId);
    }
    if (options?.runtimeSessionId) {
      messages = messages.filter(m => m.runtimeSessionId === options.runtimeSessionId);
    }
    if (options?.status) {
      messages = messages.filter(m => m.status === options.status);
    }
    if (options?.sourceType) {
      messages = messages.filter(m => m.sourceType === options.sourceType);
    }
    if (options?.priority !== undefined) {
      messages = messages.filter(m => m.priority === options.priority);
    }

    // 按 seq 升序（老的在前）
    messages.sort((a, b) => a.seq - b.seq);

    if (options?.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  /**
   * 获取当前最大序号
   */
  getCurrentSeq(): number {
    return this.nextSeq - 1;
  }

  /**
   * 标记消息已读
   */
  markRead(id: string): boolean {
    const msg = this.messages.get(id);
    if (!msg) return false;

    msg.readAt = new Date().toISOString();
    msg.updatedAt = msg.readAt;
    this.notifySubscribers(id, msg);
    return true;
  }

  /**
   * 标记消息已确认（处理完成）
   */
  markAck(id: string): boolean {
    const msg = this.messages.get(id);
    if (!msg) return false;

    msg.ackAt = new Date().toISOString();
    msg.updatedAt = msg.ackAt;
    this.notifySubscribers(id, msg);
    return true;
  }

  /**
   * 通过 callbackId 获取消息
   */
  getMessageByCallbackId(callbackId: string): MailboxMessage | undefined {
    const messageId = this.callbackIndex.get(callbackId);
    if (!messageId) return undefined;
    return this.messages.get(messageId);
  }

  /**
   * 获取消息
   */
  getMessage(id: string): MailboxMessage | undefined {
    return this.messages.get(id);
  }

  /**
   * 更新消息状态
   */
  updateStatus(
    id: string,
    status: MailboxMessage['status'],
    result?: unknown,
    error?: string
  ): boolean {
    const msg = this.messages.get(id);
    if (!msg) return false;

    msg.status = status;
    msg.updatedAt = new Date().toISOString();
    if (result !== undefined) msg.result = result;
    if (error !== undefined) msg.error = error;

    this.notifySubscribers(id, msg);
    return true;
  }

  /**
   * 获取消息列表
   */
  listMessages(options?: {
    target?: string;
    status?: MailboxMessage['status'];
    sender?: string;
    sessionId?: string;
    runtimeSessionId?: string;
    channel?: string;
    sourceType?: MailboxMessage['sourceType'];
    limit?: number;
    offset?: number;
  }): MailboxMessage[] {
    let messages = Array.from(this.messages.values());

    if (options?.target) {
      messages = messages.filter(m => m.target === options.target);
    }
    if (options?.status) {
      messages = messages.filter(m => m.status === options.status);
    }
    if (options?.sender) {
      messages = messages.filter(m => m.sender === options.sender);
    }
    if (options?.sessionId) {
      messages = messages.filter(m => m.sessionId === options.sessionId);
    }
    if (options?.runtimeSessionId) {
      messages = messages.filter(m => m.runtimeSessionId === options.runtimeSessionId);
    }
    if (options?.channel) {
      messages = messages.filter(m => m.channel === options.channel);
    }
    if (options?.sourceType) {
      messages = messages.filter(m => m.sourceType === options.sourceType);
    }

    // 按时间倒序
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (options?.offset) {
      messages = messages.slice(options.offset);
    }
    if (options?.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  /**
   * 订阅消息更新
   */
  subscribe(messageId: string, callback: (msg: MailboxMessage) => void): () => void {
    if (!this.subscribers.has(messageId)) {
      this.subscribers.set(messageId, new Set());
    }
    this.subscribers.get(messageId)!.add(callback);

    // 立即返回当前状态
    const msg = this.messages.get(messageId);
    if (msg) callback(msg);

    // 返回取消订阅函数
    return () => {
      this.subscribers.get(messageId)?.delete(callback);
    };
  }

  /**
   * 通知订阅者
   */
  private notifySubscribers(messageId: string, message: MailboxMessage): void {
    const callbacks = this.subscribers.get(messageId);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(message);
        } catch (err) {
          logger.module('mailbox').error('Subscriber error', err instanceof Error ? err : undefined);
        }
      }
    }
  }

  /**
   * 清理已完成的消息（保留最近100条）
   */
  cleanup(maxKeep = 100): void {
    const messages = Array.from(this.messages.entries());
    if (messages.length <= maxKeep) return;

    // 按时间排序，保留最新的
    messages.sort((a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime());

    const toDelete = messages.slice(maxKeep);
    for (const [id] of toDelete) {
      const msg = this.messages.get(id);
      this.messages.delete(id);
      this.subscribers.delete(id);
      // 清理 callback 索引
      if (msg?.callbackId) {
        this.callbackIndex.delete(msg.callbackId);
      }
      // 清理 seq 索引
      if (msg?.seq) {
        this.seqIndex.delete(msg.seq);
      }
    }
  }
}

// 全局 mailbox 实例
export const mailbox = new Mailbox();
