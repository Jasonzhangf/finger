import { describe, expect, it, vi } from 'vitest';
import { RuntimeFacade, type ISessionManager, type SessionInfo } from '../../../src/runtime/runtime-facade.js';
import { SYSTEM_PROJECT_PATH } from '../../../src/agents/finger-system-agent/index.js';

function createSessionManagerStub(): ISessionManager {
  const sessions = new Map<string, SessionInfo>([
    [
      'system-1',
      {
        id: 'system-1',
        name: 'system',
        projectPath: SYSTEM_PROJECT_PATH,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        context: {
          sessionTier: 'system',
          ownerAgentId: 'finger-system-agent',
        },
      },
    ],
    [
      'proj-1',
      {
        id: 'proj-1',
        name: 'project',
        projectPath: '/tmp/project-a',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        context: {
          ownerAgentId: 'finger-project-agent',
        },
      },
    ],
    [
      'proj-owned-james',
      {
        id: 'proj-owned-james',
        name: 'project-james',
        projectPath: '/tmp/project-a',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        context: {
          memoryOwnerWorkerId: 'finger-project-agent-02',
        },
      },
    ],
  ]);

  return {
    createSession: vi.fn(),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getCurrentSession: vi.fn(() => null),
    setCurrentSession: vi.fn(() => true),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    addMessage: vi.fn(async () => null),
    getMessages: vi.fn(() => []),
    deleteSession: vi.fn(() => true),
  };
}

function createToolRegistryStub() {
  return {
    execute: vi.fn(async () => ({ ok: true })),
    getPolicy: vi.fn(() => 'allow'),
    register: vi.fn(),
    list: vi.fn(() => []),
    setPolicy: vi.fn(() => true),
    isAvailable: vi.fn(() => true),
  };
}

describe('RuntimeFacade session binding hard guards', () => {
  it('rejects ephemeral dispatch session ids in bind/setCurrent', () => {
    const eventBus = { emit: vi.fn(async () => undefined), enablePersistence: vi.fn() } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);

    runtime.bindAgentSession('finger-system-agent', 'dispatch-12345');
    const switched = runtime.setCurrentSession('dispatch-12345');

    expect(switched).toBe(false);
    expect(sessionManager.setCurrentSession).not.toHaveBeenCalled();
  });

  it('enforces agent-session scope in tool execution', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-system-agent', 'echo.test');

    await runtime.callTool('finger-system-agent', 'echo.test', { ok: 1 }, { sessionId: 'proj-1' });
    await runtime.callTool('finger-system-agent', 'echo.test', { ok: 2 }, { sessionId: 'system-1' });

    const toolCalls = emits.filter((evt) => evt.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].sessionId).toBe('default');
    expect(toolCalls[1].sessionId).toBe('system-1');
  });

  it('blocks tool execution on session owned by another worker (memoryOwnerWorkerId)', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-project-agent', 'echo.test');

    await runtime.callTool('finger-project-agent', 'echo.test', { ok: true }, { sessionId: 'proj-owned-james' });

    const toolCalls = emits.filter((evt) => evt.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].sessionId).toBe('default');
    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'echo.test',
      { ok: true },
      expect.objectContaining({ sessionId: 'default' }),
    );
  });

  it('normalizes bare status tool calls to mailbox.status when alias target is whitelisted', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-system-agent', 'mailbox.status');

    await runtime.callTool('finger-system-agent', 'status', { detail: true }, { sessionId: 'system-1' });

    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'mailbox.status',
      { detail: true },
      expect.objectContaining({ agentId: 'finger-system-agent', sessionId: 'system-1' }),
    );
    const toolCall = emits.find((evt) => evt.type === 'tool_call');
    expect(toolCall).toBeTruthy();
    expect(toolCall?.toolName).toBe('mailbox.status');
  });

  it('passes session projectPath as cwd into tool execution context', async () => {
    const eventBus = { emit: vi.fn(async () => undefined), enablePersistence: vi.fn() } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-project-agent', 'echo.test');

    await runtime.callTool('finger-project-agent', 'echo.test', { ok: true }, { sessionId: 'proj-1' });

    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'echo.test',
      { ok: true },
      expect.objectContaining({
        agentId: 'finger-project-agent',
        sessionId: 'proj-1',
        cwd: '/tmp/project-a',
      }),
    );
  });

  it('normalizes command_exec alias to command.exec when whitelisted', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-system-agent', 'command.exec');

    await runtime.callTool('finger-system-agent', 'command_exec', { command: '<##help##>' }, { sessionId: 'system-1' });

    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'command.exec',
      { command: '<##help##>' },
      expect.objectContaining({ agentId: 'finger-system-agent', sessionId: 'system-1' }),
    );
    const toolCall = emits.find((evt) => evt.type === 'tool_call');
    expect(toolCall?.toolName).toBe('command.exec');
  });

  it('normalizes camelCase/flat alias to canonical tool when uniquely whitelisted', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-system-agent', 'agent.list');

    await runtime.callTool('finger-system-agent', 'agentList', {}, { sessionId: 'system-1' });
    await runtime.callTool('finger-system-agent', 'agentlist', {}, { sessionId: 'system-1' });

    expect(toolRegistry.execute).toHaveBeenNthCalledWith(
      1,
      'agent.list',
      {},
      expect.objectContaining({ agentId: 'finger-system-agent', sessionId: 'system-1' }),
    );
    expect(toolRegistry.execute).toHaveBeenNthCalledWith(
      2,
      'agent.list',
      {},
      expect.objectContaining({ agentId: 'finger-system-agent', sessionId: 'system-1' }),
    );
    const toolCalls = emits.filter((evt) => evt.type === 'tool_call');
    expect(toolCalls[0]?.toolName).toBe('agent.list');
    expect(toolCalls[1]?.toolName).toBe('agent.list');
  });

  it('normalizes legacy apply_patch alias to canonical patch when exact alias is unavailable', async () => {
    const emits: Array<Record<string, unknown>> = [];
    const eventBus = {
      emit: vi.fn(async (evt: Record<string, unknown>) => {
        emits.push(evt);
      }),
      enablePersistence: vi.fn(),
    } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    toolRegistry.isAvailable.mockImplementation((name: string) => name === 'patch');
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);
    runtime.grantToolToAgent('finger-system-agent', 'patch');

    await runtime.callTool('finger-system-agent', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: hi.txt\n+hi\n*** End Patch' }, { sessionId: 'system-1' });

    expect(toolRegistry.execute).toHaveBeenCalledWith(
      'patch',
      { patch: '*** Begin Patch\n*** Add File: hi.txt\n+hi\n*** End Patch' },
      expect.objectContaining({ agentId: 'finger-system-agent', sessionId: 'system-1' }),
    );
    const toolCall = emits.find((evt) => evt.type === 'tool_call');
    expect(toolCall?.toolName).toBe('patch');
  });

  it('keeps unknown alias denied when no whitelisted target exists', async () => {
    const eventBus = { emit: vi.fn(async () => undefined), enablePersistence: vi.fn() } as any;
    const sessionManager = createSessionManagerStub();
    const toolRegistry = createToolRegistryStub() as any;
    const runtime = new RuntimeFacade(eventBus, sessionManager, toolRegistry);

    const result = await runtime.callTool('finger-system-agent', 'agent_list', {}, { sessionId: 'system-1' }) as Record<string, unknown>;

    expect(result.__tool_access_denied).toBe(true);
    expect(result.toolName).toBe('agent_list');
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });
});
