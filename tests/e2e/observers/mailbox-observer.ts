/**
 * Mailbox Observer for E2E tests
 * Observes mailbox messages for testing inter-agent communication
 */

import { waitForCondition } from './utils.js';
import { logger } from '../../../src/core/logger.js';
import type { MailboxMessage } from '../../../src/blocks/mailbox-block/index.js';
import type { AgentCompletionNotification } from '../../../src/blocks/mailbox-block/protocol.js';

const log = logger.module('MailboxObserver');

export type MailboxEnvelope = MailboxMessage;

export interface MailboxObserverOptions {
  targetAgentId: string;
}

/**
 * Interface for mailbox-like objects that can be observed
 */
export interface ObservableMailbox {
  list(target?: string, options?: {
    status?: string;
    category?: string;
    unreadOnly?: boolean;
    limit?: number;
  }): MailboxEnvelope[];
}

/**
 * Mailbox Observer
 * Monitors mailbox for new messages
 */
export class MailboxObserver {
  private readonly mailbox: ObservableMailbox;
  private readonly targetAgentId: string;
  
  private startSeq: number = 0;
  private isObserving: boolean = false;
  private messageCache: MailboxEnvelope[] = [];

  constructor(mailbox: ObservableMailbox, targetAgentId: string);
  constructor(mailbox: ObservableMailbox, options: MailboxObserverOptions);
  constructor(
    mailbox: ObservableMailbox,
    targetAgentIdOrOptions: string | MailboxObserverOptions
  ) {
    this.mailbox = mailbox;
    
    if (typeof targetAgentIdOrOptions === 'object') {
      this.targetAgentId = targetAgentIdOrOptions.targetAgentId;
    } else {
      this.targetAgentId = targetAgentIdOrOptions;
    }
    
    log.debug('MailboxObserver created', { targetAgentId: this.targetAgentId });
  }

  /**
   * Start observing - record current nextSeq as offset
   */
  start(): void {
    this.isObserving = true;
    this.messageCache = [];
    
    // Record current messages to establish baseline
    const currentMessages = this.mailbox.list(this.targetAgentId);
    this.startSeq = currentMessages.length > 0 
      ? Math.max(...currentMessages.map(m => m.seq)) + 1 
      : 0;
    
    log.debug('MailboxObserver started', { 
      targetAgentId: this.targetAgentId,
      startSeq: this.startSeq 
    });
  }

  /**
   * Stop observing
   */
  stop(): void {
    this.isObserving = false;
    log.debug('MailboxObserver stopped');
  }

  /**
   * Get new messages since start() was called
   */
  getNewMessages(): MailboxEnvelope[] {
    const allMessages = this.mailbox.list(this.targetAgentId);
    const newMessages = allMessages.filter(m => m.seq >= this.startSeq);
    
    // Update offset for next call
    if (newMessages.length > 0) {
      this.startSeq = Math.max(...newMessages.map(m => m.seq)) + 1;
      this.messageCache.push(...newMessages);
    }
    
    return newMessages;
  }

  /**
   * Wait for InterAgentCommunication message from specific sender
   */
  async assertInterAgentReceived(from: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const messages = this.getNewMessages();
        return messages.some(m => 
          m.sender === from || 
          m.author === from ||
          (m.content && typeof m.content === 'object' && (m.content as Record<string, unknown>).author === from)
        );
      },
      timeoutMs,
      `InterAgent message from "${from}" not received within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for CompletionNotification from child agent
   */
  async assertCompletionReceived(childId: string, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const messages = this.getNewMessages();
        return messages.some(m => {
          // Check if it's a completion notification
          if (m.category === 'completion' || m.category === 'agent_completion') {
            return true;
          }
          
          // Check content for completion info
          if (m.content && typeof m.content === 'object') {
            const content = m.content as Record<string, unknown>;
            if (content.completionStatus || (content as AgentCompletionNotification).completionStatus) {
              const author = content.author as string | undefined;
              return author === childId || m.sender === childId;
            }
          }
          
          return false;
        });
      },
      timeoutMs,
      `Completion notification from "${childId}" not received within ${timeoutMs}ms`
    );
  }

  /**
   * Wait for specific number of messages
   */
  async assertMessageCount(expected: number, timeoutMs: number): Promise<void> {
    await waitForCondition(
      () => {
        const messages = this.getNewMessages();
        return messages.length >= expected;
      },
      timeoutMs,
      `Expected ${expected} messages but got ${this.messageCache.length} within ${timeoutMs}ms`
    );
  }

  /**
   * Get all messages observed so far (timeline)
   */
  getMessageTimeline(): MailboxEnvelope[] {
    return [...this.messageCache];
  }

  /**
   * Get total message count observed
   */
  getMessageCount(): number {
    return this.messageCache.length;
  }

  /**
   * Reset observer state
   */
  reset(): void {
    this.startSeq = 0;
    this.messageCache = [];
    log.debug('MailboxObserver reset');
  }
}
