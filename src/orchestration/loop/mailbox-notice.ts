/**
 * Mailbox Notice Integration
 * Lightweight pending notice handler for loop integration
 */

import type { MailboxSnapshot } from '../../runtime/mailbox-snapshot.js';
import { hasNewUnreadSinceLastNotified, getNewUnreadEntries } from '../../runtime/mailbox-snapshot.js';

export interface PendingNotice {
  id: string;
  type: 'mailbox' | 'user_input' | 'interrupt';
  priority: number; // 0 = highest, 3 = lowest
  timestamp: string;
  details: {
    mailboxSnapshot?: MailboxSnapshot;
    newEntriesCount?: number;
    unreadCategories?: string[];
    question?: string;
    options?: string[];
  };
}

export class NoticeHandler {
  private pendingNotices: Map<string, PendingNotice> = new Map();
  private lastCheckedSeq: number = 0;
  private lastNotifiedSeq: number = 0;
  private lastProcessedSnapshotSeq: number = 0; // Track last processed snapshot to avoid duplicates

  /**
   * Check mailbox for new pending messages and create notice if needed
   */
  checkMailbox(snapshot: MailboxSnapshot): PendingNotice | null {
    // Update tracking
    this.lastCheckedSeq = snapshot.currentSeq;

    // Check if there are new unread messages
    if (!hasNewUnreadSinceLastNotified(snapshot)) {
      return null;
    }

    // Get new entries
    const newEntries = getNewUnreadEntries(snapshot);
    if (newEntries.length === 0) {
      return null;
    }

    // Check if we've already created a notice for this snapshot
    if (snapshot.currentSeq <= this.lastProcessedSnapshotSeq) {
      return null;
    }

    // Group by category for summary
    const unreadCategories = Array.from(new Set(newEntries.map(e => e.category).filter(Boolean))) as string[];
    
    // Create pending notice
    const notice: PendingNotice = {
      id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'mailbox',
      priority: this.calculatePriority(newEntries),
      timestamp: new Date().toISOString(),
      details: {
        mailboxSnapshot: snapshot,
        newEntriesCount: newEntries.length,
        unreadCategories,
      },
    };

    // Store notice and mark snapshot as processed
    this.pendingNotices.set(notice.id, notice);
    this.lastProcessedSnapshotSeq = snapshot.currentSeq;

    return notice;
  }

  /**
   * Create user input pending notice
   */
  createInputNotice(question: string, options?: string[], loopId?: string, nodeId?: string): PendingNotice {
    const notice: PendingNotice = {
      id: `notice-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'user_input',
      priority: 0, // Highest priority
      timestamp: new Date().toISOString(),
      details: {
        question,
        options,
      },
    };

    this.pendingNotices.set(notice.id, notice);
    return notice;
  }

  /**
   * Get all pending notices ordered by priority
   */
  getPendingNotices(): PendingNotice[] {
    return Array.from(this.pendingNotices.values())
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Dismiss a notice
   */
  dismissNotice(noticeId: string): boolean {
    return this.pendingNotices.delete(noticeId);
  }

  /**
   * Clear all pending notices
   */
  clearAllNotices(): void {
    this.pendingNotices.clear();
  }

  /**
   * Mark notice as notified (update lastNotifiedSeq)
   */
  markAsNotified(noticeId: string): void {
    const notice = this.pendingNotices.get(noticeId);
    if (notice?.type === 'mailbox' && notice.details.mailboxSnapshot) {
      this.lastNotifiedSeq = notice.details.mailboxSnapshot.currentSeq;
    }
  }

  /**
   * Get current tracking state
   */
  getTrackingState(): { lastCheckedSeq: number; lastNotifiedSeq: number } {
    return {
      lastCheckedSeq: this.lastCheckedSeq,
      lastNotifiedSeq: this.lastNotifiedSeq,
    };
  }

  /**
   * Calculate priority based on entry types
   */
  private calculatePriority(entries: any[]): number {
    // If any entry is high priority (alert or priority 0/1), return high priority
    const hasHighPriority = entries.some(e => 
      e.category === 'alert' || 
      (typeof e.priority === 'number' && e.priority <= 1)
    );
    
    if (hasHighPriority) return 0; // Highest

    // If has task results, medium priority
    const hasTaskResults = entries.some(e => e.category === 'task-result');
    if (hasTaskResults) return 1;

    // Otherwise low priority
    return 2;
  }
}

// Global notice handler instance
export const noticeHandler = new NoticeHandler();
