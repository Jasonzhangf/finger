/**
 * CompletionWatcher - Background watcher for child agent completion
 *
 * When a child agent reaches a final status (completed/errored/shutdown),
 * this watcher automatically sends an InterAgentCommunication to the parent
 * agent's mailbox.
 *
 * Inspired by Codex Rust `control.rs:884-960` maybe_start_completion_watcher.
 *
 * Module: CompletionWatcher
 * Layer: orchestration
 */

import { logger } from '../core/logger.js';
import type { MailboxBlock } from '../blocks/mailbox-block/index.js';
import type { AgentCompletionNotification } from '../blocks/mailbox-block/protocol.js';

const log = logger.module('CompletionWatcher');

/** Possible agent lifecycle statuses. */
type AgentStatus = 'pending' | 'running' | 'completed' | 'errored' | 'shutdown';

/**
 * Check if a status is final (no further transitions possible).
 */
export function isFinalStatus(status: AgentStatus): boolean {
  return status === 'completed' || status === 'errored' || status === 'shutdown';
}

export interface CompletionWatcherOptions {
  /** Child agent unique identifier. */
  childId: string;
  /** Child AgentPath string, e.g. "/root/explorer/worker-1". */
  childPath: string;
  /** Parent AgentPath string, e.g. "/root/explorer". */
  parentPath: string;
  /** Parent's mailbox for notification delivery. */
  parentMailbox: MailboxBlock;
  /** Async function that returns the current child agent status. */
  statusProvider: () => Promise<AgentStatus>;
  /** Poll interval in milliseconds (default 1000). */
  pollIntervalMs?: number;
  /** Whether to trigger a turn on notification (default false). */
  triggerTurn?: boolean;
}

export class CompletionWatcher {
  private readonly childId: string;
  private readonly childPath: string;
  private readonly parentPath: string;
  private readonly parentMailbox: MailboxBlock;
  private readonly statusProvider: () => Promise<AgentStatus>;
  private readonly pollIntervalMs: number;
  private readonly triggerTurn: boolean;
  private running: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private completionPromise: Promise<void> | null = null;

  constructor(options: CompletionWatcherOptions) {
    this.childId = options.childId;
    this.childPath = options.childPath;
    this.parentPath = options.parentPath;
    this.parentMailbox = options.parentMailbox;
    this.statusProvider = options.statusProvider;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.triggerTurn = options.triggerTurn ?? false;
  }

  /** Whether the watcher is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start watching the child agent status.
   * Returns a promise that resolves when the child reaches a final status.
   */
  start(): Promise<void> {
    if (this.running) {
      log.warn('Watcher already running', { childId: this.childId });
      return this.completionPromise!;
    }

    this.running = true;
    log.info('CompletionWatcher started', {
      childId: this.childId,
      childPath: this.childPath,
      parentPath: this.parentPath,
    });

    this.completionPromise = new Promise<void>((resolve) => {
      this.pollTimer = setInterval(async () => {
        try {
          const status = await this.statusProvider();
          log.debug('Polled child status', { childId: this.childId, status });

          if (isFinalStatus(status)) {
            this.notifyParent(status);
            this.stop();
            resolve();
          }
        } catch (error) {
          log.error('Error polling child status', error instanceof Error ? error : undefined, {
            childId: this.childId,
          });
          this.notifyParent('errored');
          this.stop();
          resolve();
        }
      }, this.pollIntervalMs);
    });

    return this.completionPromise;
  }

  /**
   * Stop the watcher without sending notification.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('CompletionWatcher stopped', { childId: this.childId });
  }

  /**
   * Send completion notification to parent mailbox.
   */
  private notifyParent(status: AgentStatus): void {
    const notification: AgentCompletionNotification = {
      author: this.childPath,
      recipient: this.parentPath,
      content: `Agent ${this.childPath} finished with status: ${status}`,
      triggerTurn: this.triggerTurn,
      timestamp: new Date().toISOString(),
      completionStatus: (status === 'completed' || status === 'errored' || status === 'shutdown') ? status as 'completed' | 'errored' | 'shutdown' : 'errored',
      finalMessage: undefined,
    };

    try {
      const result = this.parentMailbox.sendAgentCompletion(notification);
      log.info('Completion notification sent to parent', {
        childPath: this.childPath,
        parentPath: this.parentPath,
        status,
        seq: result.seq,
      });
    } catch (error) {
      log.error('Failed to send completion notification', error instanceof Error ? error : undefined, {
        childPath: this.childPath,
        parentPath: this.parentPath,
      });
    }
  }
}

// Re-export the AgentStatus type for test consumers.
export type { AgentStatus };
