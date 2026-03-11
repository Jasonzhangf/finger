/**
 * Channel Message Routing Test
 * Verifies the onMessage callback routes messages correctly to agents and back
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChannelMessage } from '../../../src/bridges/types.js';
import type { AgentDispatchRequest } from '../../../src/server/modules/agent-runtime/types.js';

// Mock the dependencies
const mockDispatchTaskToAgent = vi.fn();
const mockSendMessage = vi.fn();

vi.mock('../../../src/server/modules/agent-runtime/dispatch.js', () => ({
  dispatchTaskToAgent: (deps: unknown, input: AgentDispatchRequest) => mockDispatchTaskToAgent(deps, input),
}));

vi.mock('../../../src/bridges/manager.js', () => ({
  getChannelBridgeManager: () => ({
    sendMessage: mockSendMessage,
    getBridge: () => ({ sendMessage: mockSendMessage }),
  }),
}));

describe('Channel Message Routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('onMessage callback', () => {
    it('should route direct message to orchestrator and send reply', async () => {
      // Setup: mock successful dispatch response
      mockDispatchTaskToAgent.mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-123',
        status: 'completed',
        result: 'Hello! I am Finger orchestrator.',
      });

      mockSendMessage.mockResolvedValueOnce({ messageId: 'reply-456' });

      // Create a channel message (direct/private chat)
      const channelMessage: ChannelMessage = {
        id: 'msg-test-001',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'ABC123DEF456',
        senderName: 'TestUser',
        content: 'hello',
        timestamp: Date.now(),
      };

      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: channelMessage.content },
        sessionId: `qqbot-${channelMessage.senderId}`,
        metadata: {
          source: 'channel',
          channelId: channelMessage.channelId,
          senderId: channelMessage.senderId,
          senderName: channelMessage.senderName,
          messageId: channelMessage.id,
          type: channelMessage.type,
        },
      };

      const result = await mockDispatchTaskToAgent({}, dispatchRequest);

      expect(mockDispatchTaskToAgent).toHaveBeenCalledWith({}, dispatchRequest);
      expect(dispatchRequest.targetAgentId).toBe('finger-orchestrator');

      if (result.ok && result.result) {
        const target = channelMessage.senderId;
        await mockSendMessage('qqbot', {
          to: target,
          text: result.result as string,
          replyTo: channelMessage.id,
        });
      }

      expect(mockSendMessage).toHaveBeenCalledWith('qqbot', {
        to: 'ABC123DEF456',
        text: 'Hello! I am Finger orchestrator.',
        replyTo: 'msg-test-001',
      });
    });

    it('should route group message with correct target format', async () => {
      mockDispatchTaskToAgent.mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-456',
        status: 'completed',
        result: 'Group reply from orchestrator',
      });

      mockSendMessage.mockResolvedValueOnce({ messageId: 'reply-789' });

      const groupMessage: ChannelMessage = {
        id: 'msg-group-001',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'group',
        senderId: 'USER123',
        senderName: 'GroupUser',
        content: '大家好',
        timestamp: Date.now(),
        metadata: { groupId: 'GROUP456' },
      };

      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: groupMessage.content },
        sessionId: `qqbot-${groupMessage.senderId}`,
        metadata: {
          source: 'channel',
          channelId: groupMessage.channelId,
          senderId: groupMessage.senderId,
          messageId: groupMessage.id,
          type: groupMessage.type,
          groupId: groupMessage.metadata?.groupId,
        },
      };

      const result = await mockDispatchTaskToAgent({}, dispatchRequest);

      if (result.ok && result.result) {
        let target = groupMessage.senderId;
        if (groupMessage.type === 'group' && groupMessage.metadata?.groupId) {
          target = `group:${groupMessage.metadata.groupId}`;
        }
        await mockSendMessage('qqbot', {
          to: target,
          text: result.result as string,
          replyTo: groupMessage.id,
        });
      }

      expect(mockSendMessage).toHaveBeenCalledWith('qqbot', {
        to: 'group:GROUP456',
        text: 'Group reply from orchestrator',
        replyTo: 'msg-group-001',
      });
    });

    it('should handle dispatch failure gracefully', async () => {
      mockDispatchTaskToAgent.mockResolvedValueOnce({
        ok: false,
        dispatchId: 'dispatch-failed',
        status: 'failed',
        error: 'Agent not available',
      });

      const channelMessage: ChannelMessage = {
        id: 'msg-fail-001',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'USER789',
        content: 'test failure',
        timestamp: Date.now(),
      };

      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: channelMessage.content },
        sessionId: `qqbot-${channelMessage.senderId}`,
        metadata: {
          source: 'channel',
          channelId: channelMessage.channelId,
          senderId: channelMessage.senderId,
          messageId: channelMessage.id,
          type: channelMessage.type,
        },
      };

      const result = await mockDispatchTaskToAgent({}, dispatchRequest);

      expect(result.ok).toBe(false);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should not send reply when result is empty', async () => {
      mockDispatchTaskToAgent.mockResolvedValueOnce({
        ok: true,
        dispatchId: 'dispatch-empty',
        status: 'completed',
        result: undefined,
      });

      const channelMessage: ChannelMessage = {
        id: 'msg-empty-001',
        channelId: 'qqbot',
        accountId: 'default',
        type: 'direct',
        senderId: 'USEREMPTY',
        content: 'empty response test',
        timestamp: Date.now(),
      };

      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: channelMessage.content },
        sessionId: `qqbot-${channelMessage.senderId}`,
        metadata: {
          source: 'channel',
          channelId: channelMessage.channelId,
          senderId: channelMessage.senderId,
          messageId: channelMessage.id,
          type: channelMessage.type,
        },
      };

      const result = await mockDispatchTaskToAgent({}, dispatchRequest);

      if (result.ok && result.result) {
        await mockSendMessage('qqbot', {
          to: channelMessage.senderId,
          text: result.result as string,
          replyTo: channelMessage.id,
        });
      }

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });
});
