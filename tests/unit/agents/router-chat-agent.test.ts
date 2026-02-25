import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RouterChatAgent, RouterOutput, RouterInput } from '../../../src/agents/router-chat/router-chat-agent.js';
import type { MessageHub } from '../../../src/orchestration/message-hub.js';

describe('RouterChatAgent', () => {
  let agent: RouterChatAgent;
  let mockHub: MessageHub;
  let capturedHandler: ((msg: unknown) => Promise<unknown>) | null = null;

  beforeEach(() => {
    agent = new RouterChatAgent();
    capturedHandler = null;
    
    mockHub = {
      registerInput: vi.fn((id: string, handler: (msg: unknown) => Promise<unknown>) => {
        capturedHandler = handler;
      }),
      registerOutput: vi.fn(),
      sendToModule: vi.fn().mockResolvedValue({ success: true, response: 'routed result' }),
    } as unknown as MessageHub;
  });

  it('should return RouterOutput format, not echo input message', async () => {
    const mockResponse = '你好！有什么我可以帮助你的吗？';
    
    const agentWithClient = agent as unknown as { 
      client: { sendMessage: () => Promise<void>; receiveMessages: () => AsyncGenerator<unknown> };
      sessionManager: { createSession: () => Promise<{ id: string }>; addMessage: () => Promise<{ id: string }>; getMessageHistory: () => Promise<Array<{ role: string; content: string }>> };
      registerHandlers: (hub: MessageHub) => Promise<void>;
    };
    
    agentWithClient.client = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      receiveMessages: async function* () {
        yield { type: 'assistant', chunk: { text: mockResponse } };
        yield { type: 'task_finish', stopReason: 'completed' };
      },
    };

    agentWithClient.sessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'test-session-id' }),
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
      getMessageHistory: vi.fn().mockResolvedValue([]),
    };

    await agentWithClient.registerHandlers(mockHub);

    expect(capturedHandler).not.toBeNull();

    const input: RouterInput = { 
      text: '你好', 
      sessionId: 'test-session',
      sender: { id: 'user', name: 'User' }
    };
    
    const result = await capturedHandler!(input);

    // Assert: result should be RouterOutput format, NOT the input message
    expect(result).toBeDefined();
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('isRouted');
    expect(result).toHaveProperty('sessionId');
    
    // Should NOT echo the input
    expect(result).not.toEqual(input);
    expect((result as RouterOutput).response).not.toBe(input.text);
    
    // Should have the LLM response
    expect((result as RouterOutput).response).toBe(mockResponse);
    expect((result as RouterOutput).success).toBe(true);
    expect((result as RouterOutput).isRouted).toBe(false);
  });

  it('should NOT return raw input message when blocking message is sent', async () => {
    const mockResponse = '这是一个搜索请求，让我帮您查找今天的国际新闻。';
    const inputMessage = { text: '搜索下今天的国际新闻', sessionId: 'test-blocking' };
    
    const agentWithClient = agent as unknown as { 
      client: { sendMessage: () => Promise<void>; receiveMessages: () => AsyncGenerator<unknown> };
      sessionManager: { createSession: () => Promise<{ id: string }>; addMessage: () => Promise<{ id: string }>; getMessageHistory: () => Promise<Array<{ role: string; content: string }>> };
      registerHandlers: (hub: MessageHub) => Promise<void>;
      hub: MessageHub | null;
    };
    
    // Mock LLM to return a proper response
    agentWithClient.client = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      receiveMessages: async function* () {
        yield { type: 'assistant', chunk: { text: mockResponse } };
        yield { type: 'task_finish', stopReason: 'completed' };
      },
    };

    agentWithClient.sessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: 'test-session-2' }),
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-456' }),
      getMessageHistory: vi.fn().mockResolvedValue([]),
    };
    
    // Set hub on agent for routing
    agentWithClient.hub = mockHub;

    await agentWithClient.registerHandlers(mockHub);

    const result = await capturedHandler!(inputMessage);

    // Critical: result should NOT be the input message
    expect(result).not.toEqual(inputMessage);
    
    // Should have processed the message and return RouterOutput format
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('response');
    expect(result).toHaveProperty('isRouted');
  });
});
