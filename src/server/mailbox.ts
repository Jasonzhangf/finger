/**
 * Mailbox - 消息邮箱系统
 * 存储消息状态，支持异步查询
 */

export interface MailboxMessage {
  id: string;
  target: string;
  content: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  sender?: string;
}

export class Mailbox {
  private messages: Map<string, MailboxMessage> = new Map();
  private subscribers: Map<string, Set<(msg: MailboxMessage) => void>> = new Map();

  /**
   * 创建新消息
   */
  createMessage(target: string, content: unknown, sender?: string): string {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const message: MailboxMessage = {
      id,
      target,
      content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      sender,
    };
    this.messages.set(id, message);
    this.notifySubscribers(id, message);
    return id;
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
          console.error('[Mailbox] Subscriber error:', err);
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
      this.messages.delete(id);
      this.subscribers.delete(id);
    }
  }
}

// 全局 mailbox 实例
export const mailbox = new Mailbox();
