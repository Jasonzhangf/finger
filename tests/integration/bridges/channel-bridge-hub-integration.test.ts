/**
 * ChannelBridge MessageHub 集成测试
 *
 * 测试完整链路：
 * ChannelBridge → Envelope → MessageHub → Agent → Output → ChannelBridge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageHub } from '../../../src/orchestration/message-hub.js';
import { createChannelBridgeInput } from '../../../src/bridges/channel-bridge-input.js';
import { createChannelBridgeOutput } from '../../../src/bridges/channel-bridge-output.js';
import { type ChannelMessage } from '../../../src/bridges/types.js';
import { type ChannelBridgeEnvelope } from '../../../src/bridges/envelope.js';

// Fake ChannelBridgeManager
function createFakeBridgeManager() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'sent-123' }),
  } as any;
}

describe('ChannelBridge MessageHub Integration', () => {
  let hub: MessageHub;
  let bridgeManager: any;
  let inputModule: ReturnType<typeof createChannelBridgeInput>;
  let outputModule: ReturnType<typeof createChannelBridgeOutput>;
  let mockAgentHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hub = new MessageHub();
    bridgeManager = createFakeBridgeManager();
    
    // Mock Agent handler
    mockAgentHandler = vi.fn().mockImplementation(async (envelope: ChannelBridgeEnvelope) => {
      // Simulate agent processing and reply
      await hub.routeToOutput('channel-bridge-qqbot', {
        channelId: envelope.channelId,
        target: envelope.senderId,
        content: `Echo: ${envelope.content}`,
        originalEnvelope: envelope,
      });
    });

    // Input module
    inputModule = createChannelBridgeInput({
      channelId: 'qqbot',
      hub,
      handler: mockAgentHandler,
    });

    // Output module
    outputModule = createChannelBridgeOutput({
      channelId: 'qqbot',
      hub,
      bridgeManager,
    });

    // Register both
    inputModule.register();
    outputModule.register();

    // Add route to connect input to agent
    hub.addRoute({
      id: 'qqbot-agent-route',
      pattern: 'channel.qqbot',
      handler: mockAgentHandler,
      blocking: true,
      priority: 1,
    });
  });

  afterEach(() => {
    inputModule.unregister();
    outputModule.unregister();
  });

  describe('完整消息链路', () => {
    it('应该处理消息并回复', async () => {
      const message: ChannelMessage = {
        id: 'test-msg-123',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-456',
        content: 'Hello Bot',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-original-msg-id',
        },
      };

      // 发送消息到 input
      await inputModule.handleChannelMessageDirect(message);

      // 验证 agent handler 被调用
      expect(mockAgentHandler).toHaveBeenCalled();
      const envelope = mockAgentHandler.mock.calls[0][0] as ChannelBridgeEnvelope;
      
      // 验证 envelope 使用原始 messageId
      expect(envelope.id).toBe('qq-original-msg-id');
      expect(envelope.metadata.messageId).toBe('qq-original-msg-id');

      // 验证回复通过 ChannelBridge 发送
      expect(bridgeManager.sendMessage).toHaveBeenCalled();
      const [, sendOptions] = bridgeManager.sendMessage.mock.calls[0];
      expect(sendOptions.text).toBe('Echo: Hello Bot');
      expect(sendOptions.replyTo).toBe('qq-original-msg-id');
    });

    it('应该正确处理群消息', async () => {
      const message: ChannelMessage = {
        id: 'test-group-msg',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'group',
        senderId: 'user-789',
        content: 'Group Hello',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-group-msg-id',
          groupId: 'group-123',
        },
      };

      await inputModule.handleChannelMessageDirect(message);

      expect(bridgeManager.sendMessage).toHaveBeenCalled();
      const [, sendOptions] = bridgeManager.sendMessage.mock.calls[0];
      expect(sendOptions.to).toBe('group:group-123');
      expect(sendOptions.replyTo).toBe('qq-group-msg-id');
    });
  });

  describe('replyTo 一致性', () => {
    it('应该始终使用 metadata.messageId 作为 replyTo', async () => {
      const testCases = [
        {
          id: 'msg-1',
          metadata: { messageId: 'qq-msg-1' },
          expectedReplyTo: 'qq-msg-1',
        },
        {
          id: 'msg-2',
          metadata: { messageId: 'ROBOT1.0_i..nd' },
          expectedReplyTo: 'ROBOT1.0_i..nd',
        },
      ];

      for (const testCase of testCases) {
        hub.removeRoute('qqbot-agent-route');
        hub.addRoute({
          id: 'qqbot-agent-route',
          pattern: 'channel.qqbot',
          handler: mockAgentHandler,
          blocking: true,
          priority: 1,
        });

        mockAgentHandler.mockClear();
        bridgeManager.sendMessage.mockClear();

        const message: ChannelMessage = {
          id: testCase.id,
          channelId: 'qqbot',
          accountId: 'default',
          type: 'direct',
          senderId: 'user-test',
          content: 'Test',
          timestamp: Date.now(),
          metadata: {
            messageId: testCase.metadata.messageId,
          },
        };

        await inputModule.handleChannelMessageDirect(message);

        const [, sendOptions] = bridgeManager.sendMessage.mock.calls[0];
        expect(sendOptions.replyTo).toBe(testCase.expectedReplyTo);
      }
    });
  });

  describe('多通道隔离', () => {
    it('应该正确路由不同通道的消息', async () => {
      const qqbotMessage: ChannelMessage = {
        id: 'qq-msg',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'user-qq',
        content: 'QQ Message',
        timestamp: Date.now(),
        metadata: {
          messageId: 'qq-msg-id',
        },
      };

      await inputModule.handleChannelMessageDirect(qqbotMessage);

      // 验证只调用了 qqbot 的 agent handler
      expect(mockAgentHandler).toHaveBeenCalledTimes(1);
      expect(bridgeManager.sendMessage).toHaveBeenCalledTimes(1);
      
      const [, sendOptions] = bridgeManager.sendMessage.mock.calls[0];
      expect(sendOptions.replyTo).toBe('qq-msg-id');
    });
  });
});
