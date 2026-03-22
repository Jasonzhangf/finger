import { describe, it, expect } from 'vitest';
import {
  buildMailboxEnvelope,
  formatEnvelopeForContext,
  formatEnvelopesForContext,
  buildHeartbeatEnvelope,
  buildDispatchResultEnvelope,
  buildUserNotificationEnvelope,
  type MailboxEnvelope,
} from '../../src/server/modules/mailbox-envelope';

describe('mailbox-envelope', () => {
  describe('buildMailboxEnvelope', () => {
    it('should build a basic envelope with required fields', () => {
      const envelope = buildMailboxEnvelope({
        category: 'System',
        title: 'Test',
        shortDescription: 'Short desc',
        fullText: 'Full text',
        source: 'test',
      });

      expect(envelope.category).toBe('System');
      expect(envelope.title).toBe('Test');
      expect(envelope.shortDescription).toBe('Short desc');
      expect(envelope.fullText).toBe('Full text');
      expect(envelope.metadata.source).toBe('test');
      expect(envelope.metadata.priority).toBe('medium');
      expect(envelope.id).toMatch(/^mail-/);
      expect(envelope.metadata.createdAt).toBeDefined();
    });

    it('should support all categories', () => {
      for (const cat of ['System', 'User', 'Notification'] as const) {
        const envelope = buildMailboxEnvelope({
          category: cat,
          title: `${cat} Test`,
          shortDescription: 'desc',
          fullText: 'text',
          source: 'test',
        });
        expect(envelope.category).toBe(cat);
      }
    });

    it('should set TTL expiration when ttlMs provided', () => {
      const envelope = buildMailboxEnvelope({
        category: 'Notification',
        title: 'TTL Test',
        shortDescription: 'desc',
        fullText: 'text',
        source: 'test',
        ttlMs: 60000,
      });

      expect(envelope.metadata.expiresAt).toBeDefined();
    });

    it('should not set expiration without ttlMs', () => {
      const envelope = buildMailboxEnvelope({
        category: 'Notification',
        title: 'No TTL',
        shortDescription: 'desc',
        fullText: 'text',
        source: 'test',
      });

      expect(envelope.metadata.expiresAt).toBeUndefined();
    });

    it('should include expectedReply when provided', () => {
      const envelope = buildMailboxEnvelope({
        category: 'System',
        title: 'Reply Test',
        shortDescription: 'desc',
        fullText: 'text',
        source: 'test',
        expectedReply: {
          format: 'text',
          description: 'Please confirm',
          optional: false,
        },
      });

      expect(envelope.expectedReply).toBeDefined();
      expect(envelope.expectedReply!.description).toBe('Please confirm');
      expect(envelope.expectedReply!.optional).toBe(false);
    });
  });

  describe('formatEnvelopeForContext', () => {
    it('should include title and short description', () => {
      const envelope = buildMailboxEnvelope({
        category: 'System',
        title: 'Test Title',
        shortDescription: 'Short desc here',
        fullText: 'Full content here',
        source: 'test',
        priority: 'high',
      });

      const result = formatEnvelopeForContext(envelope, false);
      expect(result).toContain('[System]');
      expect(result).toContain('Test Title');
      expect(result).toContain('Short desc here');
      expect(result).not.toContain('Full content here');
    });

    it('should include full text when includeFull is true', () => {
      const envelope = buildMailboxEnvelope({
        category: 'User',
        title: 'User Msg',
        shortDescription: 'desc',
        fullText: 'Detailed content',
        source: 'test',
      });

      const result = formatEnvelopeForContext(envelope, true);
      expect(result).toContain('Detailed content');
    });

    it('should show priority emoji', () => {
      const high = buildMailboxEnvelope({
        category: 'System', title: 'H', shortDescription: 'd', fullText: 'f',
        source: 'test', priority: 'high',
      });
      const low = buildMailboxEnvelope({
        category: 'System', title: 'L', shortDescription: 'd', fullText: 'f',
        source: 'test', priority: 'low',
      });

      expect(formatEnvelopeForContext(high, false)).toContain('🔴');
      expect(formatEnvelopeForContext(low, false)).toContain('🟢');
    });

    it('should mark optional replies', () => {
      const envelope = buildMailboxEnvelope({
        category: 'System',
        title: 'Opt',
        shortDescription: 'desc',
        fullText: 'text',
        source: 'test',
        expectedReply: { format: 'text', description: 'reply', optional: true },
      });

      const result = formatEnvelopeForContext(envelope, false);
      expect(result).toContain('可选');
    });
  });

  describe('formatEnvelopesForContext', () => {
    it('should return empty mailbox message for empty list', () => {
      const result = formatEnvelopesForContext([]);
      expect(result).toContain('Mailbox');
      expect(result).toContain('没有未读消息');
    });

    it('should sort by priority (high > medium > low)', () => {
      const envelopes: MailboxEnvelope[] = [
        buildMailboxEnvelope({ category: 'System', title: 'Low', shortDescription: 'd', fullText: 'f', source: 'test', priority: 'low' }),
        buildMailboxEnvelope({ category: 'System', title: 'High', shortDescription: 'd', fullText: 'f', source: 'test', priority: 'high' }),
        buildMailboxEnvelope({ category: 'User', title: 'Medium', shortDescription: 'd', fullText: 'f', source: 'test', priority: 'medium' }),
      ];

      const result = formatEnvelopesForContext(envelopes, 5000);
      const highPos = result.indexOf('High');
      const mediumPos = result.indexOf('Medium');
      const lowPos = result.indexOf('Low');

      expect(highPos).toBeLessThan(mediumPos);
      expect(mediumPos).toBeLessThan(lowPos);
    });

    it('should truncate to title only when budget is tight', () => {
      const envelopes: MailboxEnvelope[] = [
        buildMailboxEnvelope({
          category: 'System',
          title: 'Big message',
          shortDescription: 'A'.repeat(200),
          fullText: 'B'.repeat(1000),
          source: 'test',
        }),
      ];

      const result = formatEnvelopesForContext(envelopes, 50);
      expect(result).toContain('Big message');
    });
  });

  describe('buildHeartbeatEnvelope', () => {
    it('should build heartbeat envelope with low priority', () => {
      const envelope = buildHeartbeatEnvelope('Check tasks', 'proj-1');
      expect(envelope.metadata.source).toBe('heartbeat');
      expect(envelope.metadata.priority).toBe('low');
      expect(envelope.fullText).toBe('Check tasks');
      expect(envelope.metadata.relatedTaskId).toBe('proj-1');
      expect(envelope.expectedReply!.optional).toBe(true);
    });
  });

  describe('buildDispatchResultEnvelope', () => {
    it('should build success envelope with medium priority', () => {
      const envelope = buildDispatchResultEnvelope('sess-123', 'Task completed successfully');
      expect(envelope.metadata.source).toBe('dispatch');
      expect(envelope.metadata.priority).toBe('medium');
      expect(envelope.title).toContain('完成');
      expect(envelope.metadata.relatedSessionId).toBe('sess-123');
      expect(envelope.expectedReply!.optional).toBe(true);
    });

    it('should build error envelope with high priority', () => {
      const envelope = buildDispatchResultEnvelope('sess-456', 'summary', 'Connection timeout');
      expect(envelope.metadata.priority).toBe('high');
      expect(envelope.title).toContain('失败');
      expect(envelope.fullText).toContain('Connection timeout');
      expect(envelope.expectedReply!.optional).toBe(false);
    });
  });

  describe('buildUserNotificationEnvelope', () => {
    it('should build notification with User category', () => {
      const envelope = buildUserNotificationEnvelope('New Message', 'Hello world');
      expect(envelope.category).toBe('User');
      expect(envelope.title).toBe('New Message');
      expect(envelope.metadata.source).toBe('user_notification');
    });

    it('should truncate long shortDescription', () => {
      const longMsg = 'A'.repeat(200);
      const envelope = buildUserNotificationEnvelope('Title', longMsg);
      expect(envelope.shortDescription.length).toBeLessThanOrEqual(103);
      expect(envelope.shortDescription).toContain('...');
    });
  });
});
