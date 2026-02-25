/**
 * Chat Agent Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatAgent } from '../../../src/agents/chat/chat-agent.js';
import type { MessageHub } from '../../../src/orchestration/message-hub.js';

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
    protected client: object = {};
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

describe('ChatAgent', () => {
  let chatAgent: ChatAgent;
  let mockHub: MessageHub;

  beforeEach(() => {
    chatAgent = new ChatAgent();
    mockHub = {
      registerInput: vi.fn(),
      registerOutput: vi.fn(),
      sendToModule: vi.fn(),
    } as unknown as MessageHub;
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      expect(chatAgent).toBeDefined();
    });

    it('should accept custom config', () => {
      const customAgent = new ChatAgent({
        id: 'custom-chat',
        modelId: 'gpt-4-turbo',
        systemPrompt: 'Custom prompt',
      });
      expect(customAgent).toBeDefined();
    });
  });

  describe('initializeHub', () => {
    it('should register input/output handlers to Message Hub', async () => {
      await chatAgent.initializeHub(mockHub);

      expect(mockHub.registerInput).toHaveBeenCalledWith(
        'chat-agent',
        expect.any(Function)
      );
      expect(mockHub.registerOutput).toHaveBeenCalledWith(
        'chat-agent',
        expect.any(Function)
      );
    });
  });

  describe('session management', () => {
    it('should create session with title', async () => {
      await chatAgent.initializeHub(mockHub);
      const session = await chatAgent.createSession('Test Session');
      
      expect(session).toBeDefined();
      expect(session.title).toBe('Test Session');
      expect(session.id).toMatch(/^session-/);
    });

    it('should get existing session', async () => {
      await chatAgent.initializeHub(mockHub);
      const created = await chatAgent.createSession('Test');
      const retrieved = await chatAgent.getSession(created.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });
  });
});
