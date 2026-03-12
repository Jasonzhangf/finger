/**
 * Envelope 单元测试
 *
 * 验证：
 * - messageId 必须等于原始消息 ID
 * - id 必须使用原始消息 ID
 * - metadata.messageId 必须存在
 * - replyTo 必须等于 metadata.messageId
 */

import { describe, it, expect } from 'vitest';
import {
  toEnvelope,
  extractReplyTo,
  createSendOptions,
  validateEnvelope,
  assertEnvelopeValid,
  type ChannelBridgeEnvelope,
} from '../../../src/bridges/envelope.js';
import type { ChannelMessage } from '../../../src/bridges/types.js';

describe('Envelope', () => {
  describe('toEnvelope', () => {
    it('should convert ChannelMessage to Envelope with original messageId', () => {
      const message: ChannelMessage = {
        id: 'original-msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        senderName: 'Test User',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
          peerId: 'user-456',
        },
      };

      const envelope = toEnvelope(message);

      // 核心断言：id 必须使用原始消息 ID
      expect(envelope.id).toBe('qq-original-msg-id');
      // 核心断言：metadata.messageId 必须存在
      expect(envelope.metadata.messageId).toBe('qq-original-msg-id');
    });

    it('should fallback to message.id if metadata.messageId not present', () => {
      const message: ChannelMessage = {
        id: 'fallback-msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {},
      };

      const envelope = toEnvelope(message);

      expect(envelope.id).toBe('fallback-msg-123');
      expect(envelope.metadata.messageId).toBeUndefined();
    });

    it('should preserve all metadata fields', () => {
      const message: ChannelMessage = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'group',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-msg-id',
          peerId: 'user-456',
          groupId: 'group-789',
          customField: 'custom-value',
        },
      };

      const envelope = toEnvelope(message);

      expect(envelope.metadata.messageId).toBe('qq-msg-id');
      expect(envelope.metadata.peerId).toBe('user-456');
      expect(envelope.metadata.groupId).toBe('group-789');
      expect(envelope.metadata.customField).toBe('custom-value');
    });
  });

  describe('extractReplyTo', () => {
    it('should return metadata.messageId as replyTo', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      const replyTo = extractReplyTo(envelope);

      expect(replyTo).toBe('qq-original-msg-id');
    });

    it('should fallback to envelope.id if metadata.messageId not present', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: '',
        },
      };

      const replyTo = extractReplyTo(envelope);

      expect(replyTo).toBe('msg-123');
    });
  });

  describe('createSendOptions', () => {
    it('should create send options with correct replyTo', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
          peerId: 'user-456',
        },
      };

      const options = createSendOptions(envelope, 'Reply text');

      expect(options.to).toBe('user-456');
      expect(options.text).toBe('Reply text');
      expect(options.replyTo).toBe('qq-original-msg-id');
    });

    it('should use group: prefix for group messages', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'group',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
          groupId: 'group-789',
        },
      };

      const options = createSendOptions(envelope, 'Reply text');

      expect(options.to).toBe('group:group-789');
      expect(options.replyTo).toBe('qq-original-msg-id');
    });
  });

  describe('validateEnvelope', () => {
    it('should pass validation for valid envelope', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'qq-original-msg-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      const validation = validateEnvelope(envelope);

      expect(validation.messageIdIsOriginal).toBe(true);
      expect(validation.idUsesOriginal).toBe(true);
      expect(validation.hasMetadataMessageId).toBe(true);
      expect(validation.replyToMatchesMetadata).toBe(true);
    });

    it('should fail validation for missing messageId', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: '',
        },
      };

      const validation = validateEnvelope(envelope);

      expect(validation.messageIdIsOriginal).toBe(false);
      expect(validation.hasMetadataMessageId).toBe(false);
    });

    it('should fail validation for id mismatch', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'wrong-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      const validation = validateEnvelope(envelope);

      expect(validation.idUsesOriginal).toBe(false);
    });
  });

  describe('assertEnvelopeValid', () => {
    it('should not throw for valid envelope', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'qq-original-msg-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      expect(() => assertEnvelopeValid(envelope)).not.toThrow();
    });

    it('should throw for missing messageId', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: '',
        },
      };

      expect(() => assertEnvelopeValid(envelope)).toThrow(
        'Envelope missing original messageId in metadata'
      );
    });

    it('should throw for id mismatch', () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'wrong-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      expect(() => assertEnvelopeValid(envelope)).toThrow(
        'Envelope id should use original messageId'
      );
    });
  });
});
