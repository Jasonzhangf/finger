import { describe, it, expect, beforeEach } from 'vitest';
import { MailboxBlock } from '../../../../src/blocks/mailbox-block/index.js';
import type { MailboxHealth } from '../../../../src/blocks/mailbox-block/index.js';

describe('MailboxBlock.getHealth()', () => {
  let mailbox: MailboxBlock;

  beforeEach(() => {
    mailbox = new MailboxBlock('test-mailbox');
  });

  describe('basic health metrics', () => {
    it('should return empty health when no messages', () => {
      const health = mailbox.getHealth();
      
      expect(health.pending).toBe(0);
      expect(health.processing).toBe(0);
      expect(health.completed).toBe(0);
      expect(health.failed).toBe(0);
      expect(health.total).toBe(0);
      expect(health.oldestPendingAgeMs).toBeUndefined();
      expect(health.oldestProcessingAgeMs).toBeUndefined();
    });

    it('should count pending messages', () => {
      mailbox.append('agent-1', { content: 'test 1' });
      mailbox.append('agent-1', { content: 'test 2' });
      
      const health = mailbox.getHealth();
      
      expect(health.pending).toBe(2);
      expect(health.total).toBe(2);
    });

    it('should count messages by status', () => {
      const msg1 = mailbox.append('agent-1', { content: 'test 1' });
      const msg2 = mailbox.append('agent-1', { content: 'test 2' });
      const msg3 = mailbox.append('agent-1', { content: 'test 3' });
      
      mailbox.updateStatus(msg1.id, 'processing');
      mailbox.updateStatus(msg2.id, 'completed');
      mailbox.updateStatus(msg3.id, 'failed');
      
      const health = mailbox.getHealth();
      
      expect(health.pending).toBe(0);
      expect(health.processing).toBe(1);
      expect(health.completed).toBe(1);
      expect(health.failed).toBe(1);
      expect(health.total).toBe(3);
    });
  });

  describe('oldest pending age', () => {
    it('should calculate oldest pending age', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      const twoHoursAgo = new Date(now.getTime() - 7200000);
      
      // Append messages (createdAt will be current time)
      const msg1 = mailbox.append('agent-1', { content: 'old' });
      const msg2 = mailbox.append('agent-1', { content: 'new' });
      
      // Manually set createdAt for testing
      const messages = mailbox.list();
      const oldMsg = messages.find(m => m.id === msg1.id);
      const newMsg = messages.find(m => m.id === msg2.id);
      
      if (oldMsg && newMsg) {
        // Simulate older createdAt by modifying the message
        // Note: This is for testing purposes only
        (oldMsg as any).createdAt = twoHoursAgo.toISOString();
        (newMsg as any).createdAt = oneHourAgo.toISOString();
      }
      
      const health = mailbox.getHealth({ currentTime: now });
      
      expect(health.oldestPendingAgeMs).toBeCloseTo(7200000, -2);
      expect(health.oldestPendingId).toBe(msg1.id);
    });

    it('should not include non-pending messages in oldest pending age', () => {
      const now = new Date();
      const msg1 = mailbox.append('agent-1', { content: 'pending' });
      const msg2 = mailbox.append('agent-1', { content: 'processing' });
      
      mailbox.updateStatus(msg2.id, 'processing');
      
      const health = mailbox.getHealth();
      
      expect(health.oldestPendingAgeMs).toBeDefined();
      expect(health.oldestPendingId).toBe(msg1.id);
      expect(health.processing).toBe(1);
    });
  });

  describe('oldest processing age', () => {
    it('should calculate oldest processing age', () => {
      const now = new Date();
      const msg1 = mailbox.append('agent-1', { content: 'test 1' });
      const msg2 = mailbox.append('agent-1', { content: 'test 2' });
      
      mailbox.updateStatus(msg1.id, 'processing');
      mailbox.updateStatus(msg2.id, 'processing');
      
      // Manually set updatedAt for testing
      const messages = mailbox.list({ status: 'processing' });
      const olderProcessing = messages.find(m => m.id === msg1.id);
      const newerProcessing = messages.find(m => m.id === msg2.id);
      
      if (olderProcessing && newerProcessing) {
        (olderProcessing as any).updatedAt = new Date(now.getTime() - 1800000).toISOString();
        (newerProcessing as any).updatedAt = new Date(now.getTime() - 300000).toISOString();
      }
      
      const health = mailbox.getHealth({ currentTime: now });
      
      expect(health.oldestProcessingAgeMs).toBeCloseTo(1800000, -2);
      expect(health.oldestProcessingId).toBe(msg1.id);
    });
  });

  describe('custom currentTime', () => {
    it('should use provided currentTime for age calculation', () => {
      const fixedTime = new Date('2024-01-01T12:00:00Z');
      const msg = mailbox.append('agent-1', { content: 'test' });
      
      // Set createdAt to 1 hour before fixedTime
      const messages = mailbox.list();
      const testMsg = messages.find(m => m.id === msg.id);
      if (testMsg) {
        (testMsg as any).createdAt = new Date('2024-01-01T11:00:00Z').toISOString();
      }
      
      const health = mailbox.getHealth({ currentTime: fixedTime });
      
      expect(health.oldestPendingAgeMs).toBeCloseTo(3600000, -2);
    });
  });

  describe('health thresholds for heartbeat detection', () => {
    it('should detect mailbox backlog when pending > threshold', () => {
      // Append 51 pending messages (above threshold 50)
      for (let i = 0; i < 51; i++) {
        mailbox.append('agent-1', { content: `test ${i}` });
      }
      
      const health = mailbox.getHealth();
      
      expect(health.pending).toBe(51);
      expect(health.pending > 50).toBe(true); // Would trigger DEGRADED
    });

    it('should detect mailbox stale when oldest pending age > threshold', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3600000);
      
      const msg = mailbox.append('agent-1', { content: 'stale' });
      const messages = mailbox.list();
      const staleMsg = messages.find(m => m.id === msg.id);
      if (staleMsg) {
        (staleMsg as any).createdAt = oneHourAgo.toISOString();
      }
      
      const health = mailbox.getHealth({ currentTime: now });
      
      expect(health.oldestPendingAgeMs).toBeCloseTo(3600000, -2);
      expect(health.oldestPendingAgeMs! > 3600000).toBe(false); // Exactly 1 hour
    });

    it('should detect mailbox stuck when oldest processing age > threshold', () => {
      const now = new Date();
      const thirtyMinutesAgo = new Date(now.getTime() - 1800000);
      
      const msg = mailbox.append('agent-1', { content: 'stuck' });
      mailbox.updateStatus(msg.id, 'processing');
      
      const messages = mailbox.list({ status: 'processing' });
      const stuckMsg = messages.find(m => m.id === msg.id);
      if (stuckMsg) {
        (stuckMsg as any).updatedAt = thirtyMinutesAgo.toISOString();
      }
      
      const health = mailbox.getHealth({ currentTime: now });
      
      expect(health.oldestProcessingAgeMs).toBeCloseTo(1800000, -2);
      expect(health.oldestProcessingAgeMs! >= 1800000).toBe(true); // >= 30 minutes
    });
  });
});
