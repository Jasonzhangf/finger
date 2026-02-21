/**
 * RuntimeFacade tests - 统一运行时门面测试
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
 import { RuntimeFacade, type ISessionManager, type SessionInfo } from '../../../src/runtime/runtime-facade.js';
 import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
 import { ToolRegistry } from '../../../src/runtime/tool-registry.js';
 import type { Attachment } from '../../../src/runtime/events.js';

describe('RuntimeFacade', () => {
  let eventBus: UnifiedEventBus;
  let toolRegistry: ToolRegistry;
  let mockSessionManager: ISessionManager;
  let facade: RuntimeFacade;

  const createMockSession = (id: string, projectPath: string, name?: string): SessionInfo => ({
    id,
    name: name || `Session ${id}`,
    projectPath,
    status: 'active',
    messageCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    eventBus = new UnifiedEventBus();
    toolRegistry = new ToolRegistry();
    mockSessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      getCurrentSession: vi.fn(),
      setCurrentSession: vi.fn(),
      listSessions: vi.fn(),
      addMessage: vi.fn(),
      getMessages: vi.fn(),
      deleteSession: vi.fn(),
      pauseSession: vi.fn(),
      resumeSession: vi.fn(),
      compressContext: vi.fn(),
      getCompressionStatus: vi.fn(),
      isPaused: vi.fn(),
    };
    facade = new RuntimeFacade(eventBus, mockSessionManager, toolRegistry);
  });

  describe('Session Management', () => {
    it('should create session and emit event', async () => {
      const session = createMockSession('session-1', '/project/path', 'Test Session');
      vi.mocked(mockSessionManager.createSession).mockReturnValue(session);

      const handler = vi.fn();
      eventBus.subscribe('session_created', handler);

      const result = await facade.createSession('/project/path', 'Test Session');

      expect(result).toEqual(session);
      expect(mockSessionManager.createSession).toHaveBeenCalledWith('/project/path', 'Test Session');
      expect(handler).toHaveBeenCalled();
    });
    it('should handle async createSession', async () => {
      const session = createMockSession('session-2', '/async/path');
      vi.mocked(mockSessionManager.createSession).mockReturnValue(Promise.resolve(session));

      const result = await facade.createSession('/async/path');

      expect(result).toEqual(session);
    });
    it('should get session by id', () => {
      const session = createMockSession('session-3', '/path');
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);

      const result = facade.getSession('session-3');
      expect(result).toEqual(session);
      expect(mockSessionManager.getSession).toHaveBeenCalledWith('session-3');
    });
    it('should get current session', () => {
      const session = createMockSession('current', '/current');
      vi.mocked(mockSessionManager.getCurrentSession).mockReturnValue(session);
      const result = facade.getCurrentSession();

      expect(result).toEqual(session);
    });
    it('should set current session successfully', () => {
      vi.mocked(mockSessionManager.setCurrentSession).mockReturnValue(true);
      const result = facade.setCurrentSession('session-4');
      expect(result).toBe(true);
      expect(mockSessionManager.setCurrentSession).toHaveBeenCalledWith('session-4');
    });
    it('should list all sessions', () => {
      const sessions = [
        createMockSession('s1', '/p1'),
        createMockSession('s2', '/p2'),
      ];
      vi.mocked(mockSessionManager.listSessions).mockReturnValue(sessions);
      const result = facade.listSessions();

      expect(result).toEqual(sessions);
    });
    it('should delete session and clear current if same', () => {
      const session = createMockSession('to-delete', '/path');
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);
      vi.mocked(mockSessionManager.setCurrentSession).mockReturnValue(true);
      vi.mocked(mockSessionManager.deleteSession).mockReturnValue(true);

      // Set as current first
      facade.setCurrentSession('to-delete');
      const result = facade.deleteSession('to-delete');
      expect(result).toBe(true);
      expect(mockSessionManager.deleteSession).toHaveBeenCalledWith('to-delete');
    });
  });
  describe('Message Management', () => {
    it('should send user message and emit event', async () => {
      const session = createMockSession('msg-session', '/msg');
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);
      vi.mocked(mockSessionManager.addMessage).mockReturnValue({
        id: 'msg-1',
        timestamp: new Date().toISOString(),
      });

      const handler = vi.fn();
      eventBus.subscribe('user_message', handler);

      const result = await facade.sendMessage('msg-session', 'Hello', [{ type: 'text', content: 'attachment' }]);

      expect(result.messageId).toBe('msg-1');
      expect(mockSessionManager.addMessage).toHaveBeenCalledWith('msg-session', 'user', 'Hello', {
        attachments: [{ type: 'text', content: 'attachment' }],
      });
      expect(handler).toHaveBeenCalled();
    });
    it('should throw when session not found for sendMessage', async () => {
      vi.mocked(mockSessionManager.getSession).mockReturnValue(undefined);
      await expect(facade.sendMessage('non-existent', 'Hello')).rejects.toThrow('Session not found: non-existent');
    });
    it('should throw when addMessage fails', async () => {
      const session = createMockSession('fail-session', '/fail');
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);
      vi.mocked(mockSessionManager.addMessage).mockReturnValue(null);
      await expect(facade.sendMessage('fail-session', 'Hello')).rejects.toThrow('Failed to append message to session fail-session');
    });
    it('should emit assistant chunk', () => {
      const handler = vi.fn();
      eventBus.subscribe('assistant_chunk', handler);

      facade.emitAssistantChunk('session-1', 'agent-1', 'msg-1', 'chunk content');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].payload.content).toBe('chunk content');
    });
    it('should emit assistant complete', () => {
      const handler = vi.fn();
      eventBus.subscribe('assistant_complete', handler);

      facade.emitAssistantComplete('session-1', 'agent-1', 'msg-1', 'complete content', 'stop');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].payload.stopReason).toBe('stop');
    });
  });
  describe('Tool Management', () => {
    it('should register tool', () => {
      const handler = vi.fn().mockResolvedValue('result');
      facade.registerTool({
        name: 'test-tool',
        description: 'Test tool',
        inputSchema: {},
        handler,
      });
      expect(toolRegistry.get('test-tool')).toBeDefined();
    });
    it('should call tool and emit events', async () => {
      const toolHandler = vi.fn().mockResolvedValue({ success: true });
      toolRegistry.register({
        name: 'emit-tool',
        description: 'Emit tool',
        inputSchema: {},
        policy: 'allow',
        handler: toolHandler,
      });
      const callHandler = vi.fn();
      const resultHandler = vi.fn();
      eventBus.subscribe('tool_call', callHandler);
      eventBus.subscribe('tool_result', resultHandler);

      const result = await facade.callTool('agent-1', 'emit-tool', { key: 'value' });
      expect(result).toEqual({ success: true });
      expect(toolHandler).toHaveBeenCalledWith({ key: 'value' });
      expect(callHandler).toHaveBeenCalled();
      expect(resultHandler).toHaveBeenCalled();
    });
    it('should emit tool_error on failure', async () => {
      const errorHandler = vi.fn();
      toolRegistry.register({
        name: 'fail-tool',
        description: 'Fail tool',
        inputSchema: {},
        policy: 'allow',
        handler: vi.fn().mockRejectedValue(new Error('Tool failed')),
      });
      eventBus.subscribe('tool_error', errorHandler);
      await expect(facade.callTool('agent-1', 'fail-tool', {})).rejects.toThrow('Tool failed');
      expect(errorHandler).toHaveBeenCalled();
    });
    it('should throw when tool policy is deny', async () => {
      toolRegistry.register({
        name: 'denied-tool',
        description: 'Denied tool',
        inputSchema: {},
        policy: 'deny',
        handler: vi.fn(),
      });
      await expect(facade.callTool('agent-1', 'denied-tool', {})).rejects.toThrow('Tool denied-tool is not allowed');
    });
    it('should set tool policy', () => {
      toolRegistry.register({
        name: 'policy-tool',
        description: 'Policy tool',
        inputSchema: {},
        policy: 'allow',
        handler: vi.fn(),
      });
      const result = facade.setToolPolicy('policy-tool', 'deny');
      expect(result).toBe(true);
      expect(toolRegistry.getPolicy('policy-tool')).toBe('deny');
    });
    it('should list tools', () => {
      toolRegistry.register({
        name: 'list-tool',
        description: 'List tool',
        inputSchema: {},
        policy: 'allow',
        handler: vi.fn(),
      });
      const tools = facade.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('list-tool');
    });
  });
  describe('Task Progress', () => {
    it('should emit task started', () => {
      const handler = vi.fn();
      eventBus.subscribe('task_started', handler);
      facade.emitTaskStarted('session-1', 'task-1', 'Test Task', 'agent-1');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].taskId).toBe('task-1');
      expect(handler.mock.calls[0][0].payload.title).toBe('Test Task');
    });
    it('should emit task progress', () => {
      const handler = vi.fn();
      eventBus.subscribe('task_progress', handler);
      facade.emitTaskProgress('session-1', 'task-1', 50, 'Halfway', 'agent-1');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].payload.progress).toBe(50);
    });
    it('should emit task completed', () => {
      const handler = vi.fn();
      eventBus.subscribe('task_completed', handler);
      facade.emitTaskCompleted('session-1', 'task-1', { data: 'result' }, 'agent-1');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].payload.result).toEqual({ data: 'result' });
    });
    it('should emit task failed', () => {
      const handler = vi.fn();
      eventBus.subscribe('task_failed', handler);
      facade.emitTaskFailed('session-1', 'task-1', 'Something went wrong', 'agent-1');
      expect(handler).toHaveBeenCalled();
      expect(handler.mock.calls[0][0].payload.error).toBe('Something went wrong');
    });
  });
  describe('Workflow Progress', () => {
    it('should report workflow progress', () => {
      const handler = vi.fn();
      eventBus.subscribe('workflow_progress', handler);
      facade.reportProgress('session-1', {
        overall: 75,
        activeAgents: ['agent-1', 'agent-2'],
        pending: 2,
        completed: 6,
        failed: 0,
      });
      expect(handler).toHaveBeenCalled();
      const payload = handler.mock.calls[0][0].payload;
      expect(payload.overallProgress).toBe(75);
      expect(payload.activeAgents).toEqual(['agent-1', 'agent-2']);
    });
    it('should emit plan updated', () => {
      const handler = vi.fn();
      eventBus.subscribe('plan_updated', handler);
      facade.emitPlanUpdated('session-1', 'plan-1', 2, 10, 5);
      expect(handler).toHaveBeenCalled();
      const payload = handler.mock.calls[0][0].payload;
      expect(payload.planId).toBe('plan-1');
      expect(payload.taskCount).toBe(10);
      expect(payload.completedCount).toBe(5);
    });
  });
  describe('Context Compression', () => {
    it('should compress context', async () => {
      const session = createMockSession('compress-session', '/compress', undefined, 100);
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);
      vi.mocked(mockSessionManager.compressContext).mockResolvedValue('summary text');
      const handler = vi.fn();
      eventBus.subscribe('session_compressed', handler);
      const result = await facade.compressContext('compress-session');
      expect(result).toBe('summary text');
      expect(handler).toHaveBeenCalled();
    });
    it('should throw when compressContext not supported', async () => {
      const session = createMockSession('no-compress', '/no');
      const sm = { ...mockSessionManager };
      delete sm.compressContext;
      vi.mocked(mockSessionManager.getSession).mockReturnValue(session);
      const customFacade = new RuntimeFacade(eventBus, sm as ISessionManager, toolRegistry);
      await expect(customFacade.compressContext('no-compress')).rejects.toThrow('Context compression not supported');
    });
    it('should throw when session not found for compression', async () => {
      vi.mocked(mockSessionManager.getSession).mockReturnValue(undefined);
      await expect(facade.compressContext('non-existent')).rejects.toThrow('Session not found: non-existent');
    });
  });
  describe('Event Subscription', () => {
    it('should subscribe to events', () => {
      const handler = vi.fn();
      const unsubscribe = facade.subscribe('test_event', handler);
      eventBus.emit({ type: 'test_event', timestamp: new Date().toISOString() });
      expect(handler).toHaveBeenCalled();
      unsubscribe();
      handler.mockClear();
      eventBus.emit({ type: 'test_event', timestamp: new Date().toISOString() });
      expect(handler).not.toHaveBeenCalled();
    });
    it('should get event history', () => {
      facade.emitTaskStarted('session-1', 'task-1', 'Task');
      facade.emitTaskCompleted('session-1', 'task-1', {});
      const history = facade.getEventHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });
    it('should get session-specific event history', () => {
      facade.emitTaskStarted('session-1', 'task-1', 'Task');
      facade.emitTaskStarted('session-2', 'task-2', 'Task 2');
      const history = facade.getEventHistory('session-1');
      expect(history.every(e => e.sessionId === 'session-1')).toBe(true);
    });
  });
});
