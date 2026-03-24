import { describe, it, expect, vi } from 'vitest';
import { attachEventForwarding, type EventForwardingDeps } from '../../src/server/modules/event-forwarding.js';
import type { SessionManager } from '../../src/orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../src/runtime/event-bus.js';
import { heartbeatMailbox } from '../../src/server/modules/heartbeat-mailbox.js';

function createMockSessionManager(): SessionManager {
  const messages: Array<{ id: string; role: string; content: string; timestamp: string; type?: string; metadata?: Record<string, unknown> }> = [];
  return {
    addMessage: vi.fn((_sessionId: string, _role: string, content: string, _detail?: Record<string, unknown>) => {
      messages.push({
        id: `msg-${messages.length}`,
        role: _role,
        content,
        timestamp: new Date().toISOString(),
        type: (_detail as any)?.type,
        metadata: (_detail as any)?.metadata,
      });
    }),
    getMessages: vi.fn(() => messages),
    compressContext: vi.fn(async () => 'compressed'),
  } as unknown as SessionManager;
}

function createMockEventBus(): UnifiedEventBus {
  return {
    subscribe: vi.fn(),
    subscribeMultiple: vi.fn(),
    emit: vi.fn(async () => {}),
  } as unknown as UnifiedEventBus;
}

function createMockBroadcast(): ReturnType<typeof vi.fn> {
  return vi.fn();
}

function createDeps(overrides?: Partial<EventForwardingDeps>): EventForwardingDeps {
  return {
    eventBus: createMockEventBus(),
    broadcast: createMockBroadcast(),
    sessionManager: createMockSessionManager(),
    runtimeInstructionBus: { push: vi.fn() },
    inferAgentRoleLabel: (id: string) => id,
    formatDispatchResultContent: (result: unknown, error?: string) =>
      error ? `Error: ${error}` : `Result: ${JSON.stringify(result)}`,
    asString: (v: unknown) => typeof v === 'string' ? v.trim() || undefined : undefined,
    generalAgentId: 'finger-general',
    ...overrides,
  };
}

describe('Event Forwarding - Reasoning Persistence', () => {
  it('should persist reasoning events with assistant role and agent/role info', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-1',
        type: 'reasoning',
        index: 0,
        text: 'Let me analyze the code structure...',
        agentId: 'finger-orchestrator',
        roleProfile: 'orchestrator',
      },
    });

    expect(sessionManager.addMessage).toHaveBeenCalledTimes(1);
    const call = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('test-session-1'); // sessionId
    expect(call[1]).toBe('assistant'); // role - must be assistant, not system
    expect(call[2]).toContain('[role=orchestrator agent=finger-orchestrator]');
    expect(call[2]).toContain('思考: Let me analyze the code structure...');
    expect((call[3] as any).type).toBe('reasoning');
    expect((call[3] as any).agentId).toBe('finger-orchestrator');
    expect((call[3] as any).metadata.role).toBe('orchestrator');
    expect((call[3] as any).metadata.fullReasoningText).toBe('Let me analyze the code structure...');
  });

  it('should use generalAgentId when agentId is not in payload', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager, generalAgentId: 'test-default-agent' });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-2',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-2',
        type: 'reasoning',
        index: 0,
        text: 'Fallback reasoning text',
      },
    });

    const call = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toBe('assistant');
    expect(call[2]).toContain('[role=orchestrator agent=test-default-agent]');
    expect((call[3] as any).agentId).toBe('test-default-agent');
  });

  it('should use default roleProfile when not in payload', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-3',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-3',
        type: 'reasoning',
        index: 0,
        text: 'Reasoning without explicit role',
        agentId: 'some-agent',
      },
    });

    const call = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2]).toContain('[role=orchestrator agent=some-agent]');
  });

  it('should not persist empty reasoning text', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-4',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-4',
        type: 'reasoning',
        index: 0,
        text: '   ',
      },
    });

    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });

  it('should not persist non-string reasoning text', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-5',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-5',
        type: 'reasoning',
        index: 0,
        text: 42,
      },
    });

    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });

  it('should forward reasoning/body updates to agent status subscriber', () => {
    const sessionManager = createMockSessionManager();
    const mockStatusSubscriber = {
      sendReasoningUpdate: vi.fn().mockResolvedValue(undefined),
      sendBodyUpdate: vi.fn().mockResolvedValue(undefined),
    };
    const deps = createDeps({
      sessionManager,
      agentStatusSubscriber: mockStatusSubscriber as any,
    });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-forward',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-forward-1',
        type: 'reasoning',
        text: '需要先检查日志',
        agentId: 'finger-system-agent',
      },
    });

    emitLoopEventToEventBus({
      sessionId: 'test-session-forward',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-forward-2',
        type: 'model_round',
        lastAgentMessage: '这是正文更新内容',
        agentId: 'finger-system-agent',
      },
    });

    // duplicate body should be deduplicated
    emitLoopEventToEventBus({
      sessionId: 'test-session-forward',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-forward-3',
        type: 'model_round',
        lastAgentMessage: '这是正文更新内容',
        agentId: 'finger-system-agent',
      },
    });

    expect(mockStatusSubscriber.sendReasoningUpdate).toHaveBeenCalledWith(
      'test-session-forward',
      'finger-system-agent',
      '需要先检查日志',
    );
    expect(mockStatusSubscriber.sendBodyUpdate).toHaveBeenCalledTimes(1);
    expect(mockStatusSubscriber.sendBodyUpdate).toHaveBeenCalledWith(
      'test-session-forward',
      'finger-system-agent',
      '这是正文更新内容',
    );
  });
});

describe('Event Forwarding - Ledger Pointer Injection', () => {
  it('should inject main ledger pointer on turn_start', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager, generalAgentId: 'test-agent' });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-main',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: {
        text: 'hello',
      },
    });

    // Should add main ledger pointer message
    expect(sessionManager.addMessage).toHaveBeenCalledTimes(1);
    const call = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('test-session-main');
    expect(call[1]).toBe('system');
    expect(call[2]).toContain('[ledger_pointer:main]');
    expect((call[3] as any).type).toBe('ledger_pointer');
    expect((call[3] as any).metadata.ledgerPointer.label).toBe('main');
    expect((call[3] as any).agentId).toBe('test-agent');
  });

  it('should not inject duplicate main ledger pointer', () => {
    const sessionManager = {
      addMessage: vi.fn(),
      getMessages: vi.fn(() => [
        {
          id: 'existing',
          role: 'system',
          content: '[ledger_pointer:main]',
          timestamp: new Date().toISOString(),
          type: 'ledger_pointer',
          metadata: { ledgerPointer: { label: 'main' } },
        },
      ]),
    } as unknown as SessionManager;
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-dedup',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'hello' },
    });

    expect(sessionManager.addMessage).not.toHaveBeenCalled();
  });
});

describe('Event Forwarding - Dispatch Child Ledger Pointer', () => {
  function createDispatchTestDeps(): {
    deps: EventForwardingDeps;
    capturedSubscribe: { eventName: string; handler: (event: any) => void }[];
  } {
    const capturedSubscribe: { eventName: string; handler: (event: any) => void }[] = [];
    const sessionManager = createMockSessionManager();
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        capturedSubscribe.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    const deps = createDeps({
      sessionManager,
      eventBus,
      generalAgentId: 'finger-general',
    });

    // Attach to capture subscribe handlers
    attachEventForwarding(deps);

    return { deps, capturedSubscribe };
  }

  function getDispatchHandler(captured: { eventName: string; handler: (event: any) => void }[]) {
    const entry = captured.find(e => e.eventName === 'agent_runtime_dispatch');
    if (!entry) throw new Error('agent_runtime_dispatch handler not registered');
    return entry.handler;
  }

  it('should inject child ledger pointer from payload.childSessionId on dispatch completed', () => {
    const { capturedSubscribe } = createDispatchTestDeps();
    const handler = getDispatchHandler(capturedSubscribe);

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'completed',
        targetAgentId: 'finger-coder',
        assignment: { taskId: 't1' },
        childSessionId: 'child-session-123',
        result: { summary: 'done', sessionId: 'child-session-123' },
      },
    });

    // Verify that a ledger_pointer message was added via sessionManager.addMessage
    // Re-create with a trackable mock
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => []),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured2: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus2 = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured2.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus: eventBus2 }));
    const handler2 = captured2.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler2({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'completed',
        targetAgentId: 'finger-coder',
        assignment: { taskId: 't1' },
        childSessionId: 'child-session-456',
        result: { summary: 'done' },
      },
    });

    // Should have multiple messages (dispatch + ledger pointer)
    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    expect(ledgerMsgs.length).toBeGreaterThanOrEqual(1);
    const childPtr = ledgerMsgs.find(m => m.content.includes('child:child-session-456'));
    expect(childPtr).toBeDefined();
    expect(childPtr!.content).toContain('[ledger_pointer:child:child-session-456]');
  });

  it('should inject child ledger pointer from result.sessionId fallback when payload.childSessionId absent', () => {
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => []),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus }));
    const handler = captured.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session-2',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'completed',
        targetAgentId: 'finger-reviewer',
        assignment: { taskId: 't2' },
        // No payload.childSessionId - but result has sessionId (mapped to childSessionId by sanitizeDispatchResult)
        result: { summary: 'review done', sessionId: 'child-from-result-789' },
      },
    });

    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    expect(ledgerMsgs.length).toBeGreaterThanOrEqual(1);
    const childPtr = ledgerMsgs.find(m => m.content.includes('child:child-from-result-789'));
    expect(childPtr).toBeDefined();
    expect(childPtr!.content).toContain('[ledger_pointer:child:child-from-result-789]');
    // Assert metadata.label
    expect(childPtr!.metadata?.ledgerPointer?.label).toBe('child:child-from-result-789');
  });

  it('should inject child ledger pointer from result.childSessionId when both payload.childSessionId and result.childSessionId present', () => {
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => []),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus }));
    const handler = captured.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session-2b',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'completed',
        targetAgentId: 'finger-executor',
        assignment: { taskId: 't2b' },
        // No payload.childSessionId, but result.childSessionId is present
        result: { summary: 'exec done', childSessionId: 'child-from-result-childid-999' },
      },
    });

    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    expect(ledgerMsgs.length).toBeGreaterThanOrEqual(1);
    const childPtr = ledgerMsgs.find(m => m.content.includes('child:child-from-result-childid-999'));
    expect(childPtr).toBeDefined();
    expect(childPtr!.content).toContain('[ledger_pointer:child:child-from-result-childid-999]');
    // Assert metadata.label is correct
    expect(childPtr!.metadata?.ledgerPointer?.label).toBe('child:child-from-result-childid-999');
    // Assert agentId is set
    expect(childPtr!.metadata?.ledgerPointer?.agentId).toBe('finger-executor');
  });

  it('should inject child ledger pointer on dispatch failed', () => {
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => []),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus }));
    const handler = captured.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session-3',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'failed',
        targetAgentId: 'finger-executor',
        assignment: { taskId: 't3' },
        childSessionId: 'child-failed-001',
        error: 'execution timeout',
      },
    });

    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    const childPtr = ledgerMsgs.find(m => m.content.includes('child:child-failed-001'));
    expect(childPtr).toBeDefined();
    expect(childPtr!.content).toContain('[ledger_pointer:child:child-failed-001]');
  });

  it('should not inject child ledger pointer on queued status', () => {
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => []),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus }));
    const handler = captured.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session-4',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'queued',
        targetAgentId: 'finger-coder',
        queuePosition: 1,
      },
    });

    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    expect(ledgerMsgs.length).toBe(0);
  });

  it('should deduplicate child ledger pointer injection', () => {
    const messages: Array<{ sessionId: string; role: string; content: string; type?: string; metadata?: Record<string, unknown> }> = [];
    // Pre-seed with an existing child ledger pointer
    const existingMessages = [
      {
        id: 'existing-child-ptr',
        role: 'system',
        content: '[ledger_pointer:child:child-dedup-001]',
        timestamp: new Date().toISOString(),
        type: 'ledger_pointer',
        metadata: { ledgerPointer: { label: 'child:child-dedup-001' } },
      },
    ];
    const trackableSessionManager = {
      addMessage: vi.fn((sid: string, role: string, content: string, detail?: Record<string, unknown>) => {
        messages.push({ sessionId: sid, role, content, type: (detail as any)?.type, metadata: (detail as any)?.metadata });
      }),
      getMessages: vi.fn(() => existingMessages),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;

    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => {
        captured.push({ eventName, handler });
      }),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager: trackableSessionManager, eventBus }));
    const handler = captured.find(e => e.eventName === 'agent_runtime_dispatch')!.handler;

    handler({
      type: 'agent_runtime_dispatch',
      sessionId: 'parent-session-5',
      timestamp: new Date().toISOString(),
      payload: {
        status: 'completed',
        targetAgentId: 'finger-coder',
        assignment: { taskId: 't5' },
        childSessionId: 'child-dedup-001',
        result: { summary: 'done' },
      },
    });

    const ledgerMsgs = messages.filter(m => m.type === 'ledger_pointer');
    // Should NOT add duplicate - getMessages returns existing pointer
    expect(ledgerMsgs.length).toBe(0);
  });
});

describe('Event Forwarding - Dispatch Result Mailbox Routing', () => {
  it('routes completed dispatch result envelope into source agent mailbox with stored envelope', () => {
    const eventBus = {
      subscribe: vi.fn(),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ eventBus, sessionManager });
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    (eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation((eventName: string, handler: (event: any) => void) => {
      captured.push({ eventName, handler });
    });

    attachEventForwarding(deps);
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    const sourceAgentId = `test-source-agent-${Date.now()}`;
    const dispatchId = `dispatch-${Date.now()}`;
    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'session-source-mailbox',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId,
        sourceAgentId,
        targetAgentId: 'finger-project-agent',
        status: 'completed',
        result: { summary: 'done from mailbox routing' },
      },
    });

    const routed = heartbeatMailbox.list(sourceAgentId).find((message) =>
      typeof message.content === 'object'
      && message.content
      && (message.content as Record<string, unknown>).dispatchId === dispatchId);

    expect(routed).toBeDefined();
    const content = routed?.content as Record<string, unknown>;
    expect(content.envelope).toBeDefined();
    expect(content.targetAgentId).toBe(sourceAgentId);
    expect(routed?.category).toBe('notification');
  });
});

describe('Event Forwarding - Dispatch Ledger Session Lifecycle', () => {
  it('writes dispatch ledger updates into root session when runtime child session is reported', () => {
    const writes: Array<{ sessionId: string; role: string; detail?: Record<string, unknown> }> = [];
    const sessionManager = {
      addMessage: vi.fn((sessionId: string, role: string, _content: string, detail?: Record<string, unknown>) => {
        writes.push({ sessionId, role, detail });
      }),
      getMessages: vi.fn(() => []),
      getSession: vi.fn((sessionId: string) => {
        if (sessionId === 'runtime-child-1') {
          return {
            id: 'runtime-child-1',
            context: { sessionTier: 'runtime', parentSessionId: 'root-session-1', rootSessionId: 'root-session-1' },
          };
        }
        if (sessionId === 'root-session-1') {
          return {
            id: 'root-session-1',
            context: { sessionTier: 'orchestrator-root' },
          };
        }
        return null;
      }),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    attachEventForwarding(createDeps({ eventBus, sessionManager }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'runtime-child-1',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-root-route-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'completed',
        result: { summary: 'done' },
      },
    });

    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0]?.sessionId).toBe('root-session-1');
    const metadata = writes[0]?.detail?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.originalSessionId).toBe('runtime-child-1');
    expect(metadata?.dispatchId).toBe('dispatch-root-route-1');
  });

  it('deduplicates duplicate dispatch status/result writes for the same dispatch event', () => {
    const writes: Array<{ role: string }> = [];
    const sessionManager = {
      addMessage: vi.fn((_sessionId: string, role: string) => {
        writes.push({ role });
      }),
      getMessages: vi.fn(() => []),
      getSession: vi.fn((sessionId: string) => ({ id: sessionId, context: {} })),
      compressContext: vi.fn(async () => 'compressed'),
    } as unknown as SessionManager;
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    attachEventForwarding(createDeps({ eventBus, sessionManager }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    const event = {
      type: 'agent_runtime_dispatch',
      sessionId: 'root-dedup-1',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-dedup-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'completed',
        result: { summary: 'same' },
      },
    };

    handler?.(event);
    handler?.(event);

    // One system status message + one assistant result message
    expect(writes.length).toBe(2);
  });
});
