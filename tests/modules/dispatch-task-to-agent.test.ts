import { describe, it, expect, vi, beforeEach } from 'vitest';

function createDeps(executeImpl?: ReturnType<typeof vi.fn>) {
  const calls: Array<{ sessionId: string; role: string; content: string; type?: string }> = [];
  const sessionManager = {
    addMessage: vi.fn(async (sessionId: string, role: string, content: string, detail?: Record<string, unknown>) => {
      calls.push({ sessionId, role, content, type: (detail as any)?.type });
      return { id: 'msg', role, content, timestamp: new Date().toISOString() };
    }),
    getMessages: vi.fn(() => calls),
    getSession: vi.fn((id: string) => ({ id, context: {}, projectPath: '/tmp', messages: [] })),
    updateContext: vi.fn(),
  };

  return {
    deps: {
      sessionManager,
      agentRuntimeBlock: {
        execute: executeImpl ?? vi.fn(async () => ({
          ok: true,
          dispatchId: 'dispatch-1',
          status: 'completed',
          result: { summary: 'ok' },
        })),
      },
      primaryOrchestratorAgentId: 'finger-orchestrator',
      isRuntimeChildSession: vi.fn(() => false),
      isPrimaryOrchestratorTarget: vi.fn(() => false),
      ensureRuntimeChildSession: vi.fn(() => ({ id: 'child-session-1', context: {}, messages: [] })),
      ensureOrchestratorRootSession: vi.fn(() => ({ id: 'root-session-1', context: {}, messages: [] })),
      sessionWorkspaces: {
        resolveSessionWorkspaceDirsForMessage: vi.fn(() => ({
          memoryDir: '/tmp/memory',
          deliverablesDir: '/tmp/deliverables',
          exchangeDir: '/tmp/exchange',
        })),
        hydrateSessionWorkspace: vi.fn((s: any) => s),
      },
      bdTools: { assignTask: vi.fn(), addComment: vi.fn(), updateStatus: vi.fn() },
    },
    sessionCalls: calls,
    sessionManager,
  };
}

describe('dispatchTaskToAgent', () => {
  let mod: typeof import('../../src/server/modules/agent-runtime/dispatch.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    mod = await import('../../src/server/modules/agent-runtime/dispatch.js');
  });

  it('returns completed result and records dispatch user message', async () => {
    const { deps, sessionCalls } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run test',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(sessionCalls.some((c) => c.role === 'user' && c.content === 'run test' && c.type === 'dispatch')).toBe(true);
  });

  it('returns failed result when execute throws', async () => {
    const { deps } = createDeps(vi.fn(async () => { throw new Error('provider timeout'); }));
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('provider timeout');
  });

  it('passes through failed dispatch result', async () => {
    const { deps } = createDeps(
      vi.fn(async () => ({ ok: false, dispatchId: 'dispatch-fail', status: 'failed', error: 'target busy' })),
    );
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('target busy');
  });
});
