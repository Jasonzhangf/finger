import { describe, it, expect, vi, beforeEach } from 'vitest';

function createDeps(executeImpl?: ReturnType<typeof vi.fn>) {
  const calls: Array<{ sessionId: string; role: string; content: string; type?: string }> = [];
  const rootSessions = [
    { id: 'root-session-1', context: {}, projectPath: '/tmp/project-a', messages: [], lastAccessedAt: '2026-03-24T00:00:00.000Z' },
    { id: 'root-session-2', context: {}, projectPath: '/tmp/project-a', messages: [], lastAccessedAt: '2026-03-24T00:10:00.000Z' },
  ];
  const runtimeCurrentSession = { id: 'runtime-current', projectPath: '/tmp/runtime-current' };
  const sessionManager = {
    addMessage: vi.fn(async (sessionId: string, role: string, content: string, detail?: Record<string, unknown>) => {
      calls.push({ sessionId, role, content, type: (detail as any)?.type });
      return { id: 'msg', role, content, timestamp: new Date().toISOString() };
    }),
    getMessages: vi.fn(() => calls),
    getSession: vi.fn((id: string) => ({ id, context: {}, projectPath: '/tmp', messages: [] })),
    getCurrentSession: vi.fn(() => ({ id: 'session-manager-current', projectPath: '/tmp/session-manager-current' })),
    findSessionsByProjectPath: vi.fn((projectPath: string) => rootSessions.filter((item) => item.projectPath === projectPath)),
    createSession: vi.fn((projectPath: string) => ({ id: `new-session-${projectPath.split('/').pop()}`, context: {}, projectPath, messages: [] })),
    setCurrentSession: vi.fn(() => true),
    updateContext: vi.fn(() => true),
  };

  return {
    deps: {
      runtime: {
        getCurrentSession: vi.fn(() => runtimeCurrentSession),
        bindAgentSession: vi.fn(),
        setCurrentSession: vi.fn(),
      },
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
      ensureRuntimeChildSession: vi.fn(() => ({ id: 'child-session-1', projectPath: '/tmp/project-a' })),
      ensureOrchestratorRootSession: vi.fn(() => ({
        id: 'root-session-1',
        projectPath: '/tmp/project-a',
        sessionWorkspaceRoot: '/tmp/ws',
        memoryDir: '/tmp/memory',
        deliverablesDir: '/tmp/deliverables',
        exchangeDir: '/tmp/exchange',
      })),
      sessionWorkspaces: {
        resolveSessionWorkspaceDirsForMessage: vi.fn(() => ({
          memoryDir: '/tmp/memory',
          deliverablesDir: '/tmp/deliverables',
          exchangeDir: '/tmp/exchange',
        })),
        hydrateSessionWorkspace: vi.fn((sessionId: any) => ({
          id: typeof sessionId === 'string' ? sessionId : String(sessionId?.id ?? ''),
          projectPath: '/tmp/project-a',
          sessionWorkspaceRoot: '/tmp/ws',
          memoryDir: '/tmp/memory',
          deliverablesDir: '/tmp/deliverables',
          exchangeDir: '/tmp/exchange',
        })),
      },
      bdTools: { assignTask: vi.fn(), addComment: vi.fn(), updateStatus: vi.fn() },
    },
    sessionCalls: calls,
    sessionManager,
    runtimeCurrentSession,
  };
}

describe('dispatchTaskToAgent', () => {
  let mod: typeof import('../../src/server/modules/agent-runtime/dispatch.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES = '0';
    mod = await import('../../src/server/modules/agent-runtime/dispatch.js');
  });

  it('returns completed result and records dispatch user message', async () => {
    const { deps, sessionCalls, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run test',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(sessionCalls.some((c) => c.role === 'user' && c.content === 'run test' && c.type === 'dispatch')).toBe(true);
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'completed',
        dispatchId: 'dispatch-1',
        updatedBy: 'dispatch',
        targetAgentId: 'finger-coder',
      }),
    }));
  });

  it('returns failed result when execute throws', async () => {
    const { deps, sessionManager } = createDeps(vi.fn(async () => { throw new Error('provider timeout'); }));
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'finger-coder',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('provider timeout');
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        substage: 'dispatch_execute_final_error',
        updatedBy: 'dispatch',
        targetAgentId: 'finger-coder',
      }),
    }));
  });

  it('passes through failed dispatch result', async () => {
    const { deps, sessionManager } = createDeps(
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
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'failed',
        dispatchId: 'dispatch-fail',
        lastError: 'target busy',
      }),
    }));
  });

  it('auto deploys and retries when system dispatch target is not started', async () => {
    vi.resetModules();
    process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES = '1';
    const modWithRetry = await import('../../src/server/modules/agent-runtime/dispatch.js');
    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch' && execute.mock.calls.filter((c) => c[0] === 'dispatch').length === 1) {
        return {
          ok: false,
          dispatchId: 'dispatch-not-started',
          status: 'failed',
          error: 'target agent is not started in resource pool: finger-project-agent',
        };
      }
      if (command === 'deploy') {
        return { success: true };
      }
      return {
        ok: true,
        dispatchId: 'dispatch-retry-ok',
        status: 'completed',
        result: { summary: 'retry ok' },
      };
    });
    const { deps } = createDeps(execute);

    const res = await modWithRetry.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionId: 'session-1',
      metadata: { instanceCount: 2 },
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('completed');
    expect(execute).toHaveBeenCalledWith('deploy', expect.objectContaining({
      targetAgentId: 'finger-project-agent',
      instanceCount: 2,
    }));
    expect(execute.mock.calls.filter((c) => c[0] === 'dispatch')).toHaveLength(2);
  });

  it('resolves latest project session when sessionStrategy=latest', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.findSessionsByProjectPath).toHaveBeenCalledWith('/tmp/project-a');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('root-session-2');
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('defaults to latest existing session when no session/sessionStrategy is provided', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      projectPath: '/tmp/project-a',
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.findSessionsByProjectPath).toHaveBeenCalledWith('/tmp/project-a');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('root-session-2');
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('creates a new root session when sessionStrategy=new', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionStrategy: 'new',
      projectPath: '/tmp/project-b',
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.createSession).toHaveBeenCalledWith('/tmp/project-b', undefined, { allowReuse: false });
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('new-session-project-b');
    expect((deps as any).ensureRuntimeChildSession).not.toHaveBeenCalled();
  });

  it('marks queued_mailbox dispatches as dispatch_mailbox_wait_ack in lifecycle', async () => {
    const { deps, sessionManager } = createDeps(
      vi.fn(async () => ({
        ok: true,
        dispatchId: 'dispatch-mailbox-1',
        status: 'queued',
        result: { summary: 'busy timeout -> mailbox', status: 'queued_mailbox', messageId: 'msg-mailbox-1' },
      })),
    );

    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run task',
      sessionId: 'session-1',
    } as any);

    expect(res.ok).toBe(true);
    expect(res.status).toBe('queued');
    expect(sessionManager.updateContext).toHaveBeenCalledWith('session-1', expect.objectContaining({
      executionLifecycle: expect.objectContaining({
        stage: 'dispatching',
        substage: 'dispatch_mailbox_wait_ack',
        dispatchId: 'dispatch-mailbox-1',
        recoveryAction: 'mailbox',
        delivery: 'mailbox',
      }),
    }));
  });

  it('uses runtime child session only for reviewer target', async () => {
    const { deps, sessionManager } = createDeps();
    const res = await mod.dispatchTaskToAgent(deps as any, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-reviewer',
      task: 'review this',
      sessionStrategy: 'latest',
      projectPath: '/tmp/project-a',
    } as any);

    expect(res.ok).toBe(true);
    expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('root-session-2');
    expect((deps as any).ensureRuntimeChildSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'root-session-2' }), 'finger-reviewer');
  });
});
