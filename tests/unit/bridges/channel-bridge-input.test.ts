/**
 * ChannelBridge Input Module 单元测试
 *
 * 验证：
 * - 正确注册到 MessageHub
 * - 正确转换 ChannelMessage 为 Envelope
 * - 正确处理消息
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHub } from '../../../src/orchestration/message-hub.js';
import { ChannelBridgeInputModule, createChannelBridgeInput } from '../../../src/bridges/channel-bridge-input.js';
import type { ChannelMessage } from '../../../src/bridges/types.js';
import type { ChannelBridgeEnvelope } from '../../../src/bridges/envelope.js';

describe('ChannelBridgeInputModule', () => {
  let hub: MessageHub;
  let inputModule: ChannelBridgeInputModule;
  let mockHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hub = new MessageHub();
    mockHandler = vi.fn().mockResolvedValue({ ok: true });
    inputModule = createChannelBridgeInput({
      channelId: 'test-channel',
      hub,
      handler: mockHandler,
    });
  });

  afterEach(() => {
    inputModule.unregister();
  });

  describe('register', () => {
    it('should register as MessageHub input', () => {
      inputModule.register();

      const inputs = hub.getInputs();
      expect(inputs.find(i => i.id === 'channel-bridge-test-channel')).toBeDefined();
      expect(inputModule.isRegistered()).toBe(true);
    });

    it('should not register twice', () => {
      inputModule.register();
      inputModule.register();

      const inputs = hub.getInputs();
      expect(inputs.filter(i => i.id === 'channel-bridge-test-channel')).toHaveLength(1);
    });
  });

  describe('unregister', () => {
    it('should unregister from MessageHub', () => {
      inputModule.register();
      expect(inputModule.isRegistered()).toBe(true);

      inputModule.unregister();

      const inputs = hub.getInputs();
      expect(inputs.find(i => i.id === 'channel-bridge-test-channel')).toBeUndefined();
      expect(inputModule.isRegistered()).toBe(false);
    });

    it('should be safe to call when not registered', () => {
      expect(() => inputModule.unregister()).not.toThrow();
    });
  });

  describe('handleChannelMessageDirect', () => {
    it('should convert ChannelMessage to Envelope and call handler', async () => {
      inputModule.register();

      const message: ChannelMessage = {
        id: 'test-msg-123',
        channelId: 'test-channel',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello',
        timestamp: 1234567890,
        metadata: {
          messageId: 'original-msg-id',
        },
      };

      // 使用 handleChannelMessageDirect 直接调用 handler
      await inputModule.handleChannelMessageDirect(message);

      // 验证 handler 被调用
      expect(mockHandler).toHaveBeenCalled();
      const calledEnvelope = mockHandler.mock.calls[0][0] as ChannelBridgeEnvelope;
      expect(calledEnvelope.id).toBe('original-msg-id');
      expect(calledEnvelope.metadata.messageId).toBe('original-msg-id');
    });
  });

  describe('message transformation', () => {
    it('should use original messageId as envelope id', async () => {
      inputModule.register();

      const message: ChannelMessage = {
        id: 'generated-id',
        channelId: 'test-channel',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Test',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-original-id',
        },
      };

      await inputModule.handleChannelMessageDirect(message);

      const envelope = mockHandler.mock.calls[0][0] as ChannelBridgeEnvelope;
      expect(envelope.id).toBe('qq-original-id');
    });

    it('should fallback to message.id if no messageId in metadata', async () => {
      inputModule.register();

      const message: ChannelMessage = {
        id: 'fallback-id',
        channelId: 'test-channel',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Test',
        timestamp: Date.now(),
        metadata: {},
      };

      await inputModule.handleChannelMessageDirect(message);

      const envelope = mockHandler.mock.calls[0][0] as ChannelBridgeEnvelope;
      expect(envelope.id).toBe('fallback-id');
    });
  });
});
