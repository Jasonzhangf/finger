import { describe, it, expect, vi } from 'vitest';
import { attachEventForwarding, type EventForwardingDeps } from '../../src/server/modules/event-forwarding.js';
import type { SessionManager } from '../../src/orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../src/runtime/event-bus.js';
import { heartbeatMailbox } from '../../src/server/modules/heartbeat-mailbox.js';
import { resetClockStore } from '../../src/tools/internal/codex-clock-tool.js';
import { mkdtemp, readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

function createMockSessionManager(): SessionManager {
  const messages: Array<{ id: string; role: string; content: string; timestamp: string; type?: string; metadata?: Record<string, unknown> }> = [];
  const sessions = new Map<string, { id: string; context: Record<string, unknown>; projectPath?: string }>();
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
      if (!sessions.has(_sessionId)) {
        sessions.set(_sessionId, { id: _sessionId, context: {} });
      }
    }),
    getMessages: vi.fn(() => messages),
    getSession: vi.fn((sessionId: string) => {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { id: sessionId, context: {}, projectPath: process.cwd() });
      }
      return sessions.get(sessionId);
    }),
    updateContext: vi.fn((sessionId: string, context: Record<string, unknown>) => {
      const existing = sessions.get(sessionId) ?? { id: sessionId, context: {} };
      existing.context = { ...existing.context, ...context };
      sessions.set(sessionId, existing);
      return true;
    }),
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

describe('Event Forwarding - Reasoning Handling', () => {
  it('persists reasoning events as foldable system history (lower-priority context)', () => {
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

    const calls = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('test-session-1');
    expect(calls[0][1]).toBe('system');
    expect(String(calls[0][2])).toContain('<context_priority tier="P2.reasoning"');
    expect((calls[0][3] as any).type).toBe('reasoning');
    expect((calls[0][3] as any).metadata?.source).toBe('kernel_reasoning');
  });

  it('persists reasoning even when agentId is absent (fallback to generalAgentId)', () => {
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

    const calls = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][3] as any).agentId).toBe('test-default-agent');
  });

  it('persists reasoning regardless of roleProfile field', () => {
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

    const calls = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][3] as any).type).toBe('reasoning');
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

  it('persists final assistant reply on turn_complete for continuity recall', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-final-reply',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        responseId: 'resp-final-1',
        finishReason: 'completed',
        replyPreview: '已完成：SSH 重连参数已更新。',
      },
    });

    const calls = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCalls = calls.filter((call) => call[1] === 'assistant');
    expect(assistantCalls.length).toBe(1);
    expect(assistantCalls[0][0]).toBe('test-session-final-reply');
    expect(assistantCalls[0][2]).toBe('已完成：SSH 重连参数已更新。');
    expect((assistantCalls[0][3] as any).metadata.source).toBe('turn_final_reply');
  });

  it('deduplicates persisted final reply when same turn_complete emits repeatedly', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);
    const event = {
      sessionId: 'test-session-final-reply-dedup',
      phase: 'turn_complete' as const,
      timestamp: new Date().toISOString(),
      payload: {
        responseId: 'resp-final-dedup',
        finishReason: 'completed',
        replyPreview: '同一条最终回复',
      },
    };

    emitLoopEventToEventBus(event);
    emitLoopEventToEventBus(event);

    const calls = (sessionManager.addMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCalls = calls.filter((call) => call[1] === 'assistant' && call[2] === '同一条最终回复');
    expect(assistantCalls.length).toBe(1);
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

  it('forwards model_round context usage to runtime auto-compact probe', () => {
    const runtime = {
      maybeAutoCompact: vi.fn(async () => true),
    };
    const deps = createDeps({ runtime });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-auto-compact',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-auto-compact-1',
        type: 'model_round',
        contextUsagePercent: 92,
        responseId: 'resp-1',
      },
    });

    expect(runtime.maybeAutoCompact).toHaveBeenCalledWith('test-session-auto-compact', 92, 'resp-1');
  });

  it('uses session owner agentId for auto_compact_probe when model_round payload omits agentId', async () => {
    const eventBus = createMockEventBus();
    const sessionManager = createMockSessionManager();
    const deps = createDeps({
      eventBus,
      sessionManager,
      generalAgentId: 'finger-project-agent',
    });
    (sessionManager.getSession as ReturnType<typeof vi.fn>).mockImplementation((sessionId: string) => ({
      id: sessionId,
      context: { ownerAgentId: 'finger-system-agent' },
      projectPath: process.cwd(),
    }));
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'test-session-owner-agent',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        id: 'evt-owner-agent-1',
        type: 'model_round',
        contextUsagePercent: 45,
        responseId: 'resp-owner-agent',
      },
    });

    expect(eventBus.emit).toHaveBeenCalled();
    const calls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls;
    const autoProbeCall = calls.find((call) => {
      const evt = call[0] as any;
      return evt?.type === 'system_notice' && evt?.payload?.source === 'auto_compact_probe';
    });
    expect(autoProbeCall).toBeTruthy();
    expect((autoProbeCall?.[0] as any).payload.agentId).toBe('finger-system-agent');
  });
});

describe('Event Forwarding - Execution Lifecycle', () => {
  it('updates lifecycle across turn_start -> tool_call -> tool_result -> turn_complete', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'lifecycle-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'start' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_call', toolName: 'shell.exec', toolId: 'call-1' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_result', toolName: 'shell.exec' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_call', toolName: 'reasoning.stop', toolId: 'stop-1' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: { replyPreview: 'done', finishReason: 'stop' },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value
      ?? (sessionManager.getSession as ReturnType<typeof vi.fn>)('lifecycle-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'completed',
      substage: 'turn_complete',
      updatedBy: 'event-forwarding',
    }));

    const lifecycleWrites = (sessionManager.updateContext as ReturnType<typeof vi.fn>).mock.calls.map((call) => (
      (call[1] as Record<string, unknown>).executionLifecycle as Record<string, unknown>
    ));
    expect(lifecycleWrites.map((item) => item.stage)).toEqual([
      'running',
      'waiting_tool',
      'waiting_model',
      'waiting_tool',
      'completed',
    ]);
  });

  it('does not regress lifecycle when stale kernel_event arrives after turn_complete(stop)', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'lifecycle-stale-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'start' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-stale-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        replyPreview: 'done',
        finishReason: 'stop',
        responseId: 'resp-stop-terminal-1',
      },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-stale-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'tool_result',
        toolName: 'agent.dispatch',
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('lifecycle-stale-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'completed',
      substage: 'turn_complete',
      finishReason: 'stop',
    }));

    const lifecycleWrites = (sessionManager.updateContext as ReturnType<typeof vi.fn>).mock.calls.map((call) => (
      (call[1] as Record<string, unknown>).executionLifecycle as Record<string, unknown>
    ));
    expect(lifecycleWrites.map((item) => item.stage)).toEqual([
      'running',
      'completed',
    ]);
  });

  it('still transitions normally when a new turn starts after previous turn completed', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'lifecycle-new-turn-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'first turn' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-new-turn-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: { replyPreview: 'first done', finishReason: 'stop', responseId: 'resp-first-1' },
    });

    emitLoopEventToEventBus({
      sessionId: 'lifecycle-new-turn-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'second turn' },
    });
    emitLoopEventToEventBus({
      sessionId: 'lifecycle-new-turn-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_call', toolName: 'agent.dispatch', toolId: 'call-second-1' },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('lifecycle-new-turn-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'waiting_tool',
      substage: 'tool_call',
      toolName: 'agent.dispatch',
    }));

    const lifecycleWrites = (sessionManager.updateContext as ReturnType<typeof vi.fn>).mock.calls.map((call) => (
      (call[1] as Record<string, unknown>).executionLifecycle as Record<string, unknown>
    ));
    expect(lifecycleWrites.map((item) => item.stage)).toEqual([
      'running',
      'completed',
      'running',
      'waiting_tool',
    ]);
  });

  it('triggers runtime auto stop digest when turn completes with stop and reasoning.stop tool was called', async () => {
    const sessionManager = createMockSessionManager();
    const runtime = {
      maybeAutoDigestOnStop: vi.fn(async () => true),
    };
    const deps = createDeps({ sessionManager, runtime });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'auto-stop-digest-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'start' },
    });
    emitLoopEventToEventBus({
      sessionId: 'auto-stop-digest-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_call', toolName: 'reasoning.stop', toolId: 'stop-tool-1' },
    });
    emitLoopEventToEventBus({
      sessionId: 'auto-stop-digest-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: { finishReason: 'stop', responseId: 'resp-stop-1', replyPreview: 'done' },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.maybeAutoDigestOnStop).toHaveBeenCalledWith('auto-stop-digest-session-1', 'resp-stop-1');
  });

  it('emits non-blocking stop_gate notice and still finalizes when control gate requests continue on stop', async () => {
    const sessionManager = createMockSessionManager();
    const runtime = {
      maybeAutoDigestOnStop: vi.fn(async () => true),
    };
    const eventBus = createMockEventBus();
    const statusSubscriber = {
      sendBodyUpdate: vi.fn(async () => undefined),
      sendReasoningUpdate: vi.fn(async () => undefined),
      finalizeChannelTurn: vi.fn(async () => undefined),
    } as any;
    const deps = createDeps({ sessionManager, runtime, eventBus, agentStatusSubscriber: statusSubscriber });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'control-gate-hold-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'start' },
    });
    emitLoopEventToEventBus({
      sessionId: 'control-gate-hold-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        replyPreview: 'done',
        controlGateHold: true,
        controlBlockValid: false,
        controlHookNames: ['hook.task.continue'],
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('control-gate-hold-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'completed',
      substage: 'turn_complete_gate_warning',
      updatedBy: 'event-forwarding',
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.maybeAutoDigestOnStop).toHaveBeenCalledWith('control-gate-hold-session-1', undefined);
    expect(statusSubscriber.finalizeChannelTurn).toHaveBeenCalledTimes(1);
    expect(statusSubscriber.sendBodyUpdate).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system_notice',
      sessionId: 'control-gate-hold-session-1',
      payload: expect.objectContaining({
        source: 'stop_gate',
        hold: true,
        nonBlocking: true,
      }),
    }));
  });

  it('does not hold finalization when stop-tool auto-continue budget is disabled', async () => {
    const sessionManager = createMockSessionManager();
    const runtime = {
      maybeAutoDigestOnStop: vi.fn(async () => true),
    };
    const eventBus = createMockEventBus();
    const statusSubscriber = {
      sendBodyUpdate: vi.fn(async () => undefined),
      sendReasoningUpdate: vi.fn(async () => undefined),
      finalizeChannelTurn: vi.fn(async () => undefined),
    } as any;
    const deps = createDeps({ sessionManager, runtime, eventBus, agentStatusSubscriber: statusSubscriber });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'stop-gate-disabled-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        replyPreview: 'done',
        stopToolMaxAutoContinueTurns: 0,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.maybeAutoDigestOnStop).toHaveBeenCalledWith('stop-gate-disabled-session-1', undefined);
    expect(statusSubscriber.finalizeChannelTurn).toHaveBeenCalledTimes(1);
    const holdCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      const evt = call[0] as Record<string, unknown>;
      return evt?.type === 'system_notice'
        && (evt.payload as Record<string, unknown> | undefined)?.source === 'stop_gate'
        && (evt.payload as Record<string, unknown> | undefined)?.hold === true;
    });
    expect(holdCall).toBeUndefined();
  });

  it('does not hold finalization when stop-tool gate budget is exhausted', async () => {
    const sessionManager = createMockSessionManager();
    const runtime = {
      maybeAutoDigestOnStop: vi.fn(async () => true),
    };
    const eventBus = createMockEventBus();
    const statusSubscriber = {
      sendBodyUpdate: vi.fn(async () => undefined),
      sendReasoningUpdate: vi.fn(async () => undefined),
      finalizeChannelTurn: vi.fn(async () => undefined),
    } as any;
    const deps = createDeps({ sessionManager, runtime, eventBus, agentStatusSubscriber: statusSubscriber });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'stop-gate-exhausted-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        replyPreview: 'done',
        stopToolGateApplied: true,
        stopToolGateAttempt: 2,
        stopToolMaxAutoContinueTurns: 2,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.maybeAutoDigestOnStop).toHaveBeenCalledWith('stop-gate-exhausted-session-1', undefined);
    expect(statusSubscriber.finalizeChannelTurn).toHaveBeenCalledTimes(1);
    const holdCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      const evt = call[0] as Record<string, unknown>;
      return evt?.type === 'system_notice'
        && (evt.payload as Record<string, unknown> | undefined)?.source === 'stop_gate'
        && (evt.payload as Record<string, unknown> | undefined)?.hold === true;
    });
    expect(holdCall).toBeUndefined();
  });

  it('does not hold finalization when control-block gate budget is exhausted', async () => {
    const sessionManager = createMockSessionManager();
    const runtime = {
      maybeAutoDigestOnStop: vi.fn(async () => true),
    };
    const eventBus = createMockEventBus();
    const statusSubscriber = {
      sendBodyUpdate: vi.fn(async () => undefined),
      sendReasoningUpdate: vi.fn(async () => undefined),
      finalizeChannelTurn: vi.fn(async () => undefined),
    } as any;
    const deps = createDeps({ sessionManager, runtime, eventBus, agentStatusSubscriber: statusSubscriber });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'control-gate-exhausted-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        replyPreview: 'done',
        controlGateHold: true,
        controlBlockGateApplied: true,
        controlBlockGateAttempt: 2,
        controlBlockMaxAutoContinueTurns: 2,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.maybeAutoDigestOnStop).toHaveBeenCalledWith('control-gate-exhausted-session-1', undefined);
    expect(statusSubscriber.finalizeChannelTurn).toHaveBeenCalledTimes(1);
    const holdCall = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.find((call) => {
      const evt = call[0] as Record<string, unknown>;
      return evt?.type === 'system_notice'
        && (evt.payload as Record<string, unknown> | undefined)?.source === 'stop_gate'
        && (evt.payload as Record<string, unknown> | undefined)?.hold === true;
    });
    expect(holdCall).toBeUndefined();
  });

  it('executes hook.scheduler.wait by creating a clock timer with inject payload', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'finger-hook-wait-'));
    const storePath = path.join(tmpDir, 'clock-timers.jsonl');
    const previousStorePath = process.env.FINGER_CLOCK_STORE_PATH;
    process.env.FINGER_CLOCK_STORE_PATH = storePath;
    resetClockStore();
    try {
      const sessionManager = createMockSessionManager();
      const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('hook-wait-session-1');
      session.projectPath = tmpDir;
      const eventBus = createMockEventBus();
      const deps = createDeps({ sessionManager, eventBus });
      const { emitLoopEventToEventBus } = attachEventForwarding(deps);

      emitLoopEventToEventBus({
        sessionId: 'hook-wait-session-1',
        phase: 'turn_complete',
        timestamp: new Date().toISOString(),
        payload: {
          finishReason: 'stop',
          responseId: 'resp-hook-wait-1',
          controlHookNames: ['hook.scheduler.wait'],
          controlBlockValid: true,
          controlBlock: {
            wait: { enabled: true, seconds: 15, reason: 'continue later' },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      const stored = await readFile(storePath, 'utf-8');
      expect(stored).toContain('"schedule_type":"delay"');
      expect(stored).toContain('"delay_seconds":15');
      expect(stored).toContain('"agentId":"finger-general"');
      expect(stored).toContain('"sessionId":"hook-wait-session-1"');
      expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
        type: 'system_notice',
        sessionId: 'hook-wait-session-1',
        payload: expect.objectContaining({
          source: 'control_hook_action',
          hook: 'hook.scheduler.wait',
          action: 'scheduled_wait_resume',
        }),
      }));
    } finally {
      if (typeof previousStorePath === 'string') {
        process.env.FINGER_CLOCK_STORE_PATH = previousStorePath;
      } else {
        delete process.env.FINGER_CLOCK_STORE_PATH;
      }
      resetClockStore();
    }
  });

  it('executes hook.project.flow.update via append-only write with dedupe', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'finger-hook-flow-'));
    const flowPath = path.join(tmpDir, 'FLOW.md');
    const sessionManager = createMockSessionManager();
    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('hook-flow-session-1');
    session.projectPath = tmpDir;
    const eventBus = createMockEventBus();
    const deps = createDeps({ sessionManager, eventBus });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    const turnPayload = {
      finishReason: 'stop',
      responseId: 'resp-hook-flow-1',
      controlHookNames: ['hook.project.flow.update'],
      controlBlockValid: true,
      controlBlock: {
        learning: {
          flow_patch: {
            required: true,
            project_scope: tmpDir,
            changes: ['sync plan state before dispatch', 'avoid stale heartbeat wake'],
          },
        },
      },
    };

    emitLoopEventToEventBus({
      sessionId: 'hook-flow-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: turnPayload,
    });
    emitLoopEventToEventBus({
      sessionId: 'hook-flow-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: turnPayload,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const flowText = await readFile(flowPath, 'utf-8');
    expect(flowText).toContain('Control Hook Flow Patch');
    expect(flowText).toContain('flow_change: sync plan state before dispatch');
    const occurrence = (flowText.match(/idempotency_key:/g) ?? []).length;
    expect(occurrence).toBe(1);
  });

  it('executes hook.dispatch by enqueueing enforcement dispatch task', async () => {
    const sessionManager = createMockSessionManager();
    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('hook-dispatch-session-1');
    session.context.ownerAgentId = 'finger-system-agent';
    const dispatchTaskToAgent = vi.fn(async () => ({ ok: true, status: 'queued' }));
    const eventBus = createMockEventBus();
    const deps = createDeps({ sessionManager, eventBus, dispatchTaskToAgent });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'hook-dispatch-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        responseId: 'resp-hook-dispatch-1',
        controlHookNames: ['hook.dispatch'],
        controlBlockValid: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatchTaskToAgent).toHaveBeenCalledWith(expect.objectContaining({
      sourceAgentId: 'control-hook-enforcer',
      targetAgentId: 'finger-system-agent',
      sessionId: 'hook-dispatch-session-1',
      queueOnBusy: true,
      blocking: false,
    }));
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system_notice',
      sessionId: 'hook-dispatch-session-1',
      payload: expect.objectContaining({
        source: 'control_hook_action',
        hook: 'hook.dispatch',
        action: 'enforcement_dispatched',
      }),
    }));
  });

  it('skips hook.dispatch when hook.waiting_user is present in the same control block', async () => {
    const sessionManager = createMockSessionManager();
    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('hook-dispatch-waiting-user-session-1');
    session.context.ownerAgentId = 'finger-system-agent';
    const dispatchTaskToAgent = vi.fn(async () => ({ ok: true, status: 'queued' }));
    const eventBus = createMockEventBus();
    const deps = createDeps({ sessionManager, eventBus, dispatchTaskToAgent });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'hook-dispatch-waiting-user-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        finishReason: 'stop',
        responseId: 'resp-hook-dispatch-waiting-user-1',
        controlHookNames: ['hook.waiting_user', 'hook.dispatch'],
        controlBlockValid: true,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system_notice',
      sessionId: 'hook-dispatch-waiting-user-session-1',
      payload: expect.objectContaining({
        source: 'control_hook_action',
        hook: 'hook.dispatch',
        action: 'skipped_due_to_waiting_user',
      }),
    }));
  });

  it('marks dispatch queue events as dispatching in execution lifecycle', () => {
    const sessionManager = createMockSessionManager();
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager, eventBus }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'dispatch-session-1',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-queue-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'queued',
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('dispatch-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'dispatching',
      substage: 'dispatch_queued',
      dispatchId: 'dispatch-queue-1',
      targetAgentId: 'finger-project-agent',
    }));
  });

  it('persists retry metadata for turn_retry lifecycle transitions', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'retry-session-1',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'turn_retry',
        attempt: 1,
        error: 'responses stream did not contain a completed response payload',
        timeoutMs: 120000,
        retryDelayMs: 2000,
        recoveryAction: 'retry',
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('retry-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'retrying',
      substage: 'turn_retry',
      timeoutMs: 120000,
      retryDelayMs: 2000,
      recoveryAction: 'retry',
      retryCount: 1,
    }));
  });

  it('marks mailbox queued dispatches as waiting for ack in execution lifecycle', () => {
    const sessionManager = createMockSessionManager();
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager, eventBus }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'dispatch-session-mailbox-1',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-mailbox-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'queued',
        result: {
          status: 'queued_mailbox',
          messageId: 'msg-mailbox-1',
        },
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('dispatch-session-mailbox-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'dispatching',
      substage: 'dispatch_mailbox_wait_ack',
      dispatchId: 'dispatch-mailbox-1',
      targetAgentId: 'finger-project-agent',
    }));
  });

  it('marks interrupt control events as interrupted in execution lifecycle', () => {
    const sessionManager = createMockSessionManager();
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager, eventBus }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_control')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_control',
      sessionId: 'interrupt-session-1',
      timestamp: new Date().toISOString(),
      payload: {
        action: 'interrupt',
        status: 'completed',
        sessionId: 'interrupt-session-1',
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('interrupt-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'interrupted',
      substage: 'control_interrupt',
      updatedBy: 'event-forwarding',
    }));
  });

  it('maps waiting_for_user and user_decision_received to lifecycle transitions', () => {
    const sessionManager = createMockSessionManager();
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;

    attachEventForwarding(createDeps({ sessionManager, eventBus }));
    const waitingHandler = captured.find((entry) => entry.eventName === 'waiting_for_user')?.handler;
    const decisionHandler = captured.find((entry) => entry.eventName === 'user_decision_received')?.handler;
    expect(waitingHandler).toBeDefined();
    expect(decisionHandler).toBeDefined();

    waitingHandler?.({
      type: 'waiting_for_user',
      sessionId: 'waiting-session-1',
      payload: {
        reason: 'confirmation_required',
        context: { question: '需要确认是否继续' },
      },
    });

    let session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('waiting-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'waiting_user',
      substage: 'waiting_for_user',
      updatedBy: 'event-forwarding',
    }));

    decisionHandler?.({
      type: 'user_decision_received',
      sessionId: 'waiting-session-1',
      payload: { decision: '继续' },
    });

    session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('waiting-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'running',
      substage: 'user_decision_received',
      updatedBy: 'event-forwarding',
    }));
  });

  it('keeps lifecycle running when turn_complete only acknowledges pending input merge', () => {
    const sessionManager = createMockSessionManager();
    const deps = createDeps({ sessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'pending-merge-session-1',
      phase: 'turn_start',
      timestamp: new Date().toISOString(),
      payload: { text: 'start' },
    });
    emitLoopEventToEventBus({
      sessionId: 'pending-merge-session-1',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: {
        replyPreview: '已加入当前执行队列，等待本轮合并处理。',
        pendingInputAccepted: true,
        pendingTurnId: 'pending-1',
      },
    });

    const session = (sessionManager.getSession as ReturnType<typeof vi.fn>)('pending-merge-session-1');
    expect(session.context.executionLifecycle).toEqual(expect.objectContaining({
      stage: 'running',
      substage: 'pending_input_queued',
      updatedBy: 'event-forwarding',
      detail: 'pendingTurn=pending-1',
    }));
  });

  it('calls finalizeTransientLedgerMode with bound sessionManager context', async () => {
    const base = createMockSessionManager() as unknown as Record<string, unknown>;
    base.marker = 'bound-ok';
    base.finalizeTransientLedgerMode = vi.fn(function (
      this: Record<string, unknown>,
      _sessionId: string,
      _options?: { finishReason?: string; keepOnFailure?: boolean },
    ) {
      expect(this.marker).toBe('bound-ok');
      return Promise.resolve({ active: false, deleted: false });
    });

    const deps = createDeps({ sessionManager: base as unknown as SessionManager });
    const { emitLoopEventToEventBus } = attachEventForwarding(deps);

    emitLoopEventToEventBus({
      sessionId: 'transient-finalize-binding-session',
      phase: 'kernel_event',
      timestamp: new Date().toISOString(),
      payload: { type: 'tool_call', toolName: 'reasoning.stop', toolId: 'stop-finalize-1' },
    });

    emitLoopEventToEventBus({
      sessionId: 'transient-finalize-binding-session',
      phase: 'turn_complete',
      timestamp: new Date().toISOString(),
      payload: { replyPreview: 'done', finishReason: 'stop' },
    });

    await Promise.resolve();
    expect(base.finalizeTransientLedgerMode).toHaveBeenCalledTimes(1);
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
  it('routes completed dispatch result envelope into source agent mailbox with stored envelope when source system agent is busy', async () => {
    const eventBus = {
      subscribe: vi.fn(),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    const sessionManager = createMockSessionManager();
    const deps = createDeps({
      eventBus,
      sessionManager,
      isAgentBusy: () => true,
    });
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    (eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation((eventName: string, handler: (event: any) => void) => {
      captured.push({ eventName, handler });
    });

    attachEventForwarding(deps);
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    const sourceAgentId = 'finger-system-agent';
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
    await new Promise((resolve) => setTimeout(resolve, 0));

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

  it('skips mailbox routing when source system agent is idle', async () => {
    const eventBus = {
      subscribe: vi.fn(),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    const sessionManager = createMockSessionManager();
    const deps = createDeps({
      eventBus,
      sessionManager,
      isAgentBusy: () => false,
    });
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    (eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation((eventName: string, handler: (event: any) => void) => {
      captured.push({ eventName, handler });
    });

    attachEventForwarding(deps);
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    const sourceAgentId = 'finger-system-agent';
    const dispatchId = `dispatch-idle-${Date.now()}`;
    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'session-source-idle',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId,
        sourceAgentId,
        targetAgentId: 'finger-project-agent',
        status: 'completed',
        result: { summary: 'done without mailbox' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const routed = heartbeatMailbox.list(sourceAgentId).find((message) =>
      typeof message.content === 'object'
      && message.content
      && (message.content as Record<string, unknown>).dispatchId === dispatchId);
    expect(routed).toBeUndefined();
  });

  it('skips mailbox routing for non-system source agents even when source is busy', async () => {
    const eventBus = {
      subscribe: vi.fn(),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    const sessionManager = createMockSessionManager();
    const deps = createDeps({
      eventBus,
      sessionManager,
      isAgentBusy: () => true,
    });
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    (eventBus.subscribe as ReturnType<typeof vi.fn>).mockImplementation((eventName: string, handler: (event: any) => void) => {
      captured.push({ eventName, handler });
    });

    attachEventForwarding(deps);
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    const sourceAgentId = `finger-project-agent-${Date.now()}`;
    const dispatchId = `dispatch-skip-source-${Date.now()}`;
    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'session-non-system-source',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId,
        sourceAgentId,
        targetAgentId: 'finger-system-agent',
        status: 'completed',
        result: { summary: 'done without source mailbox callback' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const routed = heartbeatMailbox.list(sourceAgentId).find((message) =>
      typeof message.content === 'object'
      && message.content
      && (message.content as Record<string, unknown>).dispatchId === dispatchId);
    expect(routed).toBeUndefined();
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

describe('Event Forwarding - Auto Review Prompt Integration', () => {
  it('builds verification-aware reviewer prompt when auto review is enabled', async () => {
    const sessionManager = createMockSessionManager();
    const dispatchTaskToAgent = vi.fn(async () => ({
      ok: true,
      status: 'queued',
      dispatchId: 'dispatch-reviewer-1',
    }));
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    attachEventForwarding(createDeps({
      eventBus,
      sessionManager,
      dispatchTaskToAgent,
      resolveReviewPolicy: () => ({ enabled: true, dispatchReviewMode: 'always' }),
    }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'system-main',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-project-done-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        status: 'completed',
        assignment: {
          taskId: 'task-auto-review-1',
          attempt: 1,
          acceptanceCriteria: ['must pass tests', 'must provide evidence'],
        },
        result: {
          summary: 'implemented changes',
          changedFiles: ['src/runtime/runtime-facade.ts'],
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatchTaskToAgent).toHaveBeenCalledTimes(1);
    const request = dispatchTaskToAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.targetAgentId).toBe('finger-reviewer');
    const task = request.task as Record<string, unknown>;
    const prompt = typeof task?.prompt === 'string' ? task.prompt : '';
    expect(prompt).toContain('[AUTO-REVIEW GATE]');
    expect(prompt).toContain('<verification>');
    expect(prompt).toContain('Decision Contract');
    expect(prompt).toContain('report-task-completion');
  });

  it('parses verifier verdict output and redispatches rework to project agent', async () => {
    const sessionManager = createMockSessionManager();
    const dispatchTaskToAgent = vi.fn(async () => ({
      ok: true,
      status: 'queued',
      dispatchId: 'dispatch-project-rework-1',
    }));
    const captured: { eventName: string; handler: (event: any) => void }[] = [];
    const eventBus = {
      subscribe: vi.fn((eventName: string, handler: (event: any) => void) => captured.push({ eventName, handler })),
      subscribeMultiple: vi.fn(),
      emit: vi.fn(async () => {}),
    } as unknown as UnifiedEventBus;
    attachEventForwarding(createDeps({
      eventBus,
      sessionManager,
      dispatchTaskToAgent,
      resolveReviewPolicy: () => ({ enabled: true, dispatchReviewMode: 'always' }),
    }));
    const handler = captured.find((entry) => entry.eventName === 'agent_runtime_dispatch')?.handler;
    expect(handler).toBeDefined();

    handler?.({
      type: 'agent_runtime_dispatch',
      sessionId: 'system-main',
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: 'dispatch-reviewer-done-1',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-reviewer',
        status: 'completed',
        assignment: {
          taskId: 'task-auto-review-2',
          attempt: 1,
        },
        result: {
          response: '<verification><verdict>FAIL</verdict></verification>',
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(dispatchTaskToAgent).toHaveBeenCalledTimes(1);
    const request = dispatchTaskToAgent.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.targetAgentId).toBe('finger-project-agent');
    const metadata = request.metadata as Record<string, unknown>;
    expect(metadata.reviewDecision).toBe('retry');
  });
});
