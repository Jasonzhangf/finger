/**
 * RouterChatAgent + BaseAgent 集成测试
 * 
 * 测试范围:
 * 1. BaseAgent 基础功能 (Session管理，状态广播)
 * 2. RouterChatAgent 路由逻辑
 * 3. EventBus 状态更新
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RouterChatAgentSimple } from '../../../src/agents/router-chat/router-chat-agent-simple.js';
import { MessageHub } from '../../../src/orchestration/message-hub.js';
import { globalEventBus } from '../../../src/runtime/event-bus.js';

// Mock dependencies
vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('../../../src/agents/sdk/iflow-base.js', () => ({
  IflowBaseAgent: class MockIflowBaseAgent {
    protected client = {
      chat: vi.fn().mockResolvedValue({ content: '{"intent":"research","confidence":0.9,"targetAgent":"research-agent","shouldRoute":true}' }),
    };
    protected info = {
      sessionId: 'test-session',
      connected: true,
      cwd: '',
      addDirs: [],
      availableCommands: [],
      availableAgents: [],
      availableSkills: [],
      availableMcpServers: [],
    };
    
    async initialize() {
      return this.info;
    }
  },
}));

describe('RouterChatAgent + BaseAgent Integration', () => {
  let agent: RouterChatAgentSimple;
  let mockHub: MessageHub;
  let eventSpy: any;

  beforeEach(() => {
    agent = new RouterChatAgentSimple();
    mockHub = {
      registerInput: vi.fn(),
      registerOutput: vi.fn(),
      sendToModule: vi.fn(),
    } as unknown as MessageHub;
    
    // Spy on EventBus
    eventSpy = vi.spyOn(globalEventBus, 'emit');
  });

  describe('BaseAgent Features', () => {
    it('should initialize with BaseAgent features', async () => {
      await agent.initializeBase(mockHub);
      
      expect(mockHub.registerInput).toHaveBeenCalledWith('router-chat-agent', expect.any(Function));
      expect(mockHub.registerOutput).toHaveBeenCalledWith('router-chat-agent', expect.any(Function));
    });

    it('should emit status updates during initialization', async () => {
      await agent.initializeBase(mockHub);
      
      // Should emit initialization events
      expect(eventSpy).toHaveBeenCalled();
      
      const emittedEvents = eventSpy.mock.calls.map(call => call[0]);
      const initEvent = emittedEvents.find((e: any) => e.type === 'agent_step_completed' && e.step === 'initialized');
      expect(initEvent).toBeDefined();
    });

    it('should manage session', async () => {
      await agent.initializeBase(mockHub);
      
      const session = await (agent as any).getOrCreateSession('test-123', 'Test Session');
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
    });

    it('should add messages to history', async () => {
      await agent.initializeBase(mockHub);
      await (agent as any).getOrCreateSession();
      
      const message = await (agent as any).addMessage('user', 'Test message');
      expect(message).toBeDefined();
      expect(message.content).toBe('Test message');
      expect(message.role).toBe('user');
    });
  });

  describe('RouterChatAgent Routing Logic', () => {
    it('should route research queries', async () => {
      await agent.initializeBase(mockHub);
      
      const inputHandler = (mockHub.registerInput as any).mock.calls[0][1];
      const result = await inputHandler({
        text: '搜索下今天的国际新闻',
        sessionId: 'test-session',
        sender: { id: 'user' },
      });
      
      expect(result.success).toBe(true);
      expect(result.result.isRouted).toBe(true);
      expect(result.result.targetAgent).toBe('research-agent');
    });

    it('should handle forced routes', async () => {
      await agent.initializeBase(mockHub);
      
      const inputHandler = (mockHub.registerInput as any).mock.calls[0][1];
      const result = await inputHandler({
        text: '/sys status',
        sessionId: 'test-session',
        sender: { id: 'user' },
      });
      
      // Forced route should work
      expect(result.success).toBe(true);
      expect(result.result.isRouted).toBe(true);
      expect(result.result.isForced).toBe(true);
    });

    it('should emit status updates during routing', async () => {
      await agent.initializeBase(mockHub);
      
      const inputHandler = (mockHub.registerInput as any).mock.calls[0][1];
      await inputHandler({
        text: '搜索下今天的国际新闻',
        sessionId: 'test-session',
        sender: { id: 'user' },
      });
      
      // Should emit multiple status updates
      const statusEvents = eventSpy.mock.calls
        .map(call => call[0])
        .filter((e: any) => e.type === 'agent_step_completed');
      
      expect(statusEvents.length).toBeGreaterThan(2);
      
      const phases = statusEvents.map((e: any) => e.step);
      expect(phases).toContain('analyzing');
      expect(phases).toContain('llm_call');
    });
  });

  describe('Error Handling', () => {
    it('should handle parse errors gracefully', async () => {
      // Mock invalid JSON response
      (agent as any).callLLM = vi.fn().mockResolvedValue('Invalid JSON response');
      
      await agent.initializeBase(mockHub);
      
      const inputHandler = (mockHub.registerInput as any).mock.calls[0][1];
      const result = await inputHandler({
        text: 'Test message',
        sessionId: 'test-session',
        sender: { id: 'user' },
      });
      
      // Should fallback to default behavior
      expect(result.success).toBe(true);
      expect(result.result.isRouted).toBe(false);
    });

    it('should emit error events on failure', async () => {
      // Mock LLM failure
      (agent as any).callLLM = vi.fn().mockRejectedValue(new Error('LLM failed'));
      
      await agent.initializeBase(mockHub);
      
      const inputHandler = (mockHub.registerInput as any).mock.calls[0][1];
      const result = await inputHandler({
        text: 'Test message',
        sessionId: 'test-session',
        sender: { id: 'user' },
      });
      
      // Should handle error
      expect(result.success).toBe(false);
      
      // Should emit error event
      const errorEvents = eventSpy.mock.calls
        .map(call => call[0])
        .filter((e: any) => e.status === 'failed');
      
      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });
});
