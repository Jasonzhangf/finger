/**
 * Feishu WebSocket Agent Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuWebSocketAgent, createFeishuAgent } from '../../../src/agents/feishu/feishu-websocket-agent.js';

describe('FeishuWebSocketAgent', () => {
  let agent: FeishuWebSocketAgent;
  let mockHub: any;
  let registeredInput: any;
  let registeredOutput: any;
  let addedRoutes: any[];

  beforeEach(() => {
    agent = createFeishuAgent({
      appId: 'test-app-id',
      appSecret: 'test-secret',
    });

    registeredInput = null;
    registeredOutput = null;
    addedRoutes = [];

    mockHub = {
      registerInput: vi.fn((id, handler) => {
        registeredInput = { id, handler };
      }),
      registerOutput: vi.fn((id, handler) => {
        registeredOutput = { id, handler };
      }),
      addRoute: vi.fn((route) => {
        addedRoutes.push(route);
      }),
      send: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  it('should register input/output and route on initialize', async () => {
    await agent.initialize(mockHub);

    expect(mockHub.registerInput).toHaveBeenCalledWith(
      'feishu-ws-input',
      expect.any(Function)
    );
    expect(mockHub.registerOutput).toHaveBeenCalledWith(
      'feishu-ws-output',
      expect.any(Function)
    );
    expect(mockHub.addRoute).toHaveBeenCalledWith({
      id: 'feishu-to-output',
      match: { type: 'feishu.message' },
      dest: ['feishu-ws-output'],
      priority: 100
    });
  });

  it('should handle incoming message and trigger hub.send', async () => {
    await agent.initialize(mockHub);

    const testMessage = {
      type: 'text' as const,
      chatId: 'chat-123',
      userId: 'user-456',
      content: 'Hello from Feishu',
      messageId: 'msg-789',
      timestamp: Date.now(),
    };

    // 直接调用已注册的 input handler
    const result = await registeredInput.handler(testMessage);

    expect(mockHub.send).toHaveBeenCalledWith({
      type: 'feishu.message',
      payload: testMessage,
      meta: expect.objectContaining({ source: 'feishu-ws-input' })
    });
    expect(result).toEqual({ success: true, forwarded: true, result: { success: true } });
  });

  it('should handle outgoing message and trigger callback', async () => {
    await agent.initialize(mockHub);

    const testMessage = {
      type: 'text' as const,
      chatId: 'chat-123',
      userId: 'user-456',
      content: 'Reply to Feishu',
      messageId: 'msg-reply',
      timestamp: Date.now(),
    };

    const mockCallback = vi.fn();

    // 直接调用已注册的 output handler
    const result = await registeredOutput.handler(testMessage, mockCallback);

    expect(mockCallback).toHaveBeenCalledWith({
      success: true,
      messageId: expect.stringMatching(/^msg-/),
    });
    expect(result).toHaveProperty('success', true);
  });

  it('should support connect and disconnect commands', async () => {
    const connectResult = await agent.execute('connect', {});
    expect(connectResult).toEqual({ success: true });

    const disconnectResult = await agent.execute('disconnect', {});
    expect(disconnectResult).toEqual({ success: true });
  });

  it('should throw error for unknown command', async () => {
    await expect(agent.execute('unknown', {})).rejects.toThrow('Unknown command');
  });
});
