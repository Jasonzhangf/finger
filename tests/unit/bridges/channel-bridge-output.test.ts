/**
 * ChannelBridge Output Module 单元测试
 *
 * 验证：
 * - 正确注册到 MessageHub
 * - 正确路由输出到 ChannelBridge
 * - replyTo 使用 metadata.messageId
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHub } from '../../../src/orchestration/message-hub.js';
import { createChannelBridgeOutput } from '../../../src/bridges/channel-bridge-output.js';
import type { ChannelBridgeEnvelope } from '../../../src/bridges/envelope.js';
import type { ChannelBridgeManager } from '../../../src/bridges/manager.js';

// Fake ChannelBridgeManager
function createFakeBridgeManager() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'sent-123' }),
  } as unknown as ChannelBridgeManager;
}

describe('ChannelBridgeOutputModule', () => {
  let hub: MessageHub;
  let bridgeManager: ChannelBridgeManager;
  let outputModule: ReturnType<typeof createChannelBridgeOutput>;

  beforeEach(() => {
    hub = new MessageHub();
    bridgeManager = createFakeBridgeManager();
    outputModule = createChannelBridgeOutput({
      channelId: 'qqbot',
      hub,
      bridgeManager,
    });
  });

  afterEach(() => {
    outputModule.unregister();
  });

  describe('register', () => {
    it('should register as MessageHub output', () => {
      outputModule.register();

      const outputs = hub.getOutputs();
      expect(outputs.find(o => o.id === 'channel-bridge-qqbot')).toBeDefined();
      expect(outputModule.isRegistered()).toBe(true);
    });

    it('should not register twice', () => {
      outputModule.register();
      outputModule.register();

      const outputs = hub.getOutputs();
      expect(outputs.filter(o => o.id === 'channel-bridge-qqbot')).toHaveLength(1);
    });
  });

  describe('unregister', () => {
    it('should unregister from MessageHub', () => {
      outputModule.register();
      expect(outputModule.isRegistered()).toBe(true);

      outputModule.unregister();

      const outputs = hub.getOutputs();
      expect(outputs.find(o => o.id === 'channel-bridge-qqbot')).toBeUndefined();
      expect(outputModule.isRegistered()).toBe(false);
    });

    it('should be safe to call when not registered', () => {
      expect(() => outputModule.unregister()).not.toThrow();
    });
  });

  describe('handleOutput via MessageHub', () => {
    it('should route output to ChannelBridge.sendMessage with replyTo', async () => {
      outputModule.register();

      const envelope: ChannelBridgeEnvelope = {
        id: 'qq-original-msg-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-123',
        content: 'hello',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-original-msg-id',
          peerId: 'user-123',
        },
      };

      const outputMessage = {
        channelId: 'qqbot',
        target: 'user-123',
        content: 'reply text',
        originalEnvelope: envelope,
      };

      await hub.routeToOutput('channel-bridge-qqbot', outputMessage);

      expect(bridgeManager.sendMessage).toHaveBeenCalled();
      const [bridgeId, options] = (bridgeManager.sendMessage as any).mock.calls[0];
      expect(bridgeId).toBe('qqbot');
      expect(options.text).toBe('reply text');
      expect(options.replyTo).toBe('qq-original-msg-id');
      expect(options.to).toBe('user-123');
    });

    it('should use group: prefix for group messages', async () => {
      outputModule.register();

      const envelope: ChannelBridgeEnvelope = {
        id: 'qq-group-msg-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'group',
        senderId: 'user-456',
        content: 'hello',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-group-msg-id',
          groupId: 'group-789',
        },
      };

      const outputMessage = {
        channelId: 'qqbot',
        target: 'group-789',
        content: 'group reply',
        originalEnvelope: envelope,
      };

      await hub.routeToOutput('channel-bridge-qqbot', outputMessage);

      const [, options] = (bridgeManager.sendMessage as any).mock.calls[0];
      expect(options.to).toBe('group:group-789');
      expect(options.replyTo).toBe('qq-group-msg-id');
    });
  });

  describe('sendReply', () => {
    it('should send reply directly', async () => {
      const envelope: ChannelBridgeEnvelope = {
        id: 'qq-msg-id',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-789',
        content: 'hello',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-msg-id',
          peerId: 'user-789',
        },
      };

      await outputModule.sendReply(envelope, 'reply');

      expect(bridgeManager.sendMessage).toHaveBeenCalled();
      const [, options] = (bridgeManager.sendMessage as any).mock.calls[0];
      expect(options.text).toBe('reply');
      expect(options.replyTo).toBe('qq-msg-id');
    });
  });
});
