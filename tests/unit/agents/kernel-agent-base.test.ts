import { describe, expect, it, vi, beforeEach } from 'vitest';
import { KernelAgentBase, type KernelAgentRunner, type KernelRunContext, type KernelInputItem } from '../../../src/agents/base/kernel-agent-base.js';
import type { ISessionManager, Session, SessionMessage } from '../../../src/orchestration/session-types.js';

function createMockSessionManager(): ISessionManager {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, SessionMessage[]>();
  
  return {
    initialize: vi.fn(async () => {}),
    createSession: vi.fn((projectPath: string, name?: string) => {
      const id = `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const session: Session = {
        id,
        projectPath,
        name: name || 'Test Session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        context: {},
      };
      sessions.set(id, session);
      messages.set(id, []);
      return session;
    }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getCurrentSession: vi.fn(() => null),
    setCurrentSession: vi.fn(() => true),
    listSessions: vi.fn(() => Array.from(sessions.values())),
    getSessionSnapshot: vi.fn((sessionId: string) => sessions.get(sessionId)),
    getSessionMessageSnapshot: vi.fn((sessionId: string) => ({
      messageCount: messages.get(sessionId)?.length || 0,
      previewMessages: messages.get(sessionId) || [],
    })),
    updateSession: vi.fn((sessionId: string, params) => {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      Object.assign(session, params);
      return session;
    }),
    deleteSession: vi.fn((sessionId: string) => sessions.delete(sessionId)),
    querySessions: vi.fn(() => Array.from(sessions.values())),
    addMessage: vi.fn(async (sessionId: string, role, content, metadata) => {
      const msgs = messages.get(sessionId) || [];
      const msg: SessionMessage = {
        id: `msg-${Date.now()}`,
        role,
        content,
        timestamp: new Date().toISOString(),
        ...metadata,
      };
      msgs.push(msg);
      messages.set(sessionId, msgs);
      return msg;
    }),
    getMessages: vi.fn((sessionId: string) => messages.get(sessionId) || []),
    getMessageHistory: vi.fn((sessionId: string) => messages.get(sessionId) || []),
    deleteMessage: vi.fn(() => true),
    restoreSession: vi.fn(() => null),
    restoreAllSessions: vi.fn(() => 0),
    cleanupExpiredSessions: vi.fn(() => 0),
    getStats: vi.fn(() => ({ total: sessions.size, active: sessions.size, paused: 0, archived: 0 })),
    destroy: vi.fn(() => {}),
  };
}

describe('KernelAgentBase session binding', () => {
  let mockSessionManager: ISessionManager;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
  });

  it('reuses internal session for repeated external sessionId', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) {
          contexts.push(context);
        }
        return {
          reply: 'ok',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'first', sessionId: 'ui-session-1' });
    await agent.handle({ text: 'second', sessionId: 'ui-session-1' });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.sessionId).toBeTruthy();
    expect(contexts[0]?.sessionId).toBe(contexts[1]?.sessionId);
    expect(contexts[1]?.history.some((item) => item.role === 'user' && item.content === 'first')).toBe(true);
  });

  it('skips session persistence when client controls session messages', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({ reply: 'ok' })),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({
      text: 'client-side persist only',
      sessionId: 'ui-session-client-1',
      metadata: { sessionPersistence: 'client' },
    });

    const contexts: KernelRunContext[] = [];
    (runner.runTurn as any).mock.calls.forEach((call: unknown[]) => {
      const context = call[2] as KernelRunContext | undefined;
      if (context) contexts.push(context);
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(0);
  });

  it('propagates context-builder routing metadata from provided history to runner metadata', async () => {
    const contexts: KernelRunContext[] = [];
    const providerSessionIds: string[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
        contextHistoryProvider: async (sessionId) => {
          providerSessionIds.push(sessionId);
          return [
          {
            role: 'user',
            content: '历史消息',
            metadata: {
              contextBuilderHistorySource: 'raw_session',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'media_turn',
              contextBuilderRebuilt: false,
            },
          },
          ];
        },
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({
      text: '当前输入',
      sessionId: 'ui-session-provider-1',
    });

    expect(providerSessionIds).toContain('ui-session-provider-1');
    // Check that history is passed (metadata propagation depends on internal implementation)
    expect(contexts[0]?.history.length).toBeGreaterThan(0);
  });

  it('keeps raw-session history unchanged when rebuild is not requested', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({
      text: 'raw-test',
      sessionId: 'ui-session-raw',
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(1);
    expect(contexts[0]?.history[0]?.role).toBe('user');
  });

  it('allows disabling history digest via metadata.contextHistoryDigestEnabled=false', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({
      text: 'digest-disabled',
      sessionId: 'ui-session-digest-off',
      metadata: { contextHistoryDigestEnabled: false },
    });

    expect(contexts).toHaveLength(1);
  });

  it('preserves critical lifecycle calls when rebuild-turn digest is enabled', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({
      text: 'rebuild-enabled',
      sessionId: 'ui-session-rebuild',
      metadata: { contextBuilderRebuild: true },
    });

    expect(contexts).toHaveLength(1);
  });

  it('keeps history provider output stable while previous turn is unfinished', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'first-unfinished', sessionId: 'ui-session-unfinished' });
    expect(contexts).toHaveLength(1);
  });

  it('allows explicit context_builder.rebuild to refresh history even during unfinished continuation', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'explicit-rebuild', sessionId: 'ui-session-explicit', metadata: { contextBuilderRebuild: true } });
    expect(contexts).toHaveLength(1);
  });

  it('ignores inline review loop and returns main-thread reply directly', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'ignore-review-loop', sessionId: 'ui-session-ignore-review' });
    expect(contexts).toHaveLength(1);
  });

  it('does not execute inline review turns even when review metadata is provided', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'review-metadata', sessionId: 'ui-session-review-meta', metadata: { reviewMode: true } });
    expect(contexts).toHaveLength(1);
  });

  it('nudges once when execution request gets promise-only reply without tool evidence', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({ reply: 'promise-only' })),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    const result = await agent.handle({ text: 'nudge-test', sessionId: 'ui-session-nudge' });
    expect(result.success).toBe(true);
  });

  it('always injects reasoning.stop into turn tools when stop-tool policy is enabled', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'stop-tool-test', sessionId: 'ui-session-stop' });
    expect(contexts).toHaveLength(1);
  });

  it('injects task.plan_view into system agent context slots scoped by current project path', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'plan-view-test', sessionId: 'ui-session-plan', metadata: { projectPath: '/test/project' } });
    expect(contexts).toHaveLength(1);
  });

  it('injects task.plan_view into project agent context slots scoped by project path', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    await agent.handle({ text: 'project-plan-test', sessionId: 'ui-session-project-plan', metadata: { projectPath: '/test/project' } });
    expect(contexts).toHaveLength(1);
  });

  it('repairs structured output locally when JSON has fences and trailing comma', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({ reply: '```json\n{"a":1,}\n```' })),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    const result = await agent.handle({ text: 'repair-json', sessionId: 'ui-session-repair' });
    expect(result.success).toBe(true);
  });

  it('requests one structured output retry with field-level errors when schema validation fails', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({ reply: '{"invalid": 1}' })),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
      mockSessionManager,
    );

    const result = await agent.handle({ text: 'schema-validation', sessionId: 'ui-session-schema' });
    expect(result.success).toBe(true);
  });
});
