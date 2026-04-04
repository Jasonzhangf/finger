import { describe, expect, it, vi } from 'vitest';
import { resolveDispatchSessionSelection } from '../../../src/server/modules/agent-runtime/dispatch-runtime-helpers.js';

function createDeps(overrides?: {
  boundSessionId?: string | null;
  runtimeCurrentSessionId?: string | null;
  managerCurrentSessionId?: string | null;
  sessions?: Record<string, { id: string; projectPath: string; context?: Record<string, unknown> }>;
  findSessionsByProjectPathResult?: Array<{ id: string; projectPath: string; context?: Record<string, unknown>; lastAccessedAt?: string }>;
}) {
  const sessions = overrides?.sessions ?? {
    'session-current': { id: 'session-current', projectPath: '/repo/project-a', context: {} },
    'session-bound': { id: 'session-bound', projectPath: '/repo/project-a', context: {} },
  };
  const ensureSession = vi.fn((id: string, projectPath: string) => ({
    id,
    projectPath,
    context: {},
  }));
  const sessionManager = {
    getSession: vi.fn((id: string) => sessions[id]),
    getCurrentSession: vi.fn(() => {
      const id = overrides?.managerCurrentSessionId === undefined
        ? 'session-current'
        : overrides.managerCurrentSessionId;
      return id ? sessions[id] ?? { id, projectPath: '/repo/project-a', context: {} } : null;
    }),
    createSession: vi.fn(),
    setCurrentSession: vi.fn(),
    findSessionsByProjectPath: vi.fn(() => overrides?.findSessionsByProjectPathResult ?? []),
    ensureSession,
    updateContext: vi.fn(),
  };
  const runtime = {
    getBoundSessionId: vi.fn(() => overrides?.boundSessionId ?? null),
    getCurrentSession: vi.fn(() => {
      const id = overrides?.runtimeCurrentSessionId === undefined
        ? 'session-current'
        : overrides.runtimeCurrentSessionId;
      return id ? sessions[id] ?? { id, projectPath: '/repo/project-a', context: {} } : null;
    }),
  };
  return {
    deps: {
      runtime,
      sessionManager,
      isRuntimeChildSession: vi.fn(() => false),
    } as any,
    runtime,
    sessionManager,
  };
}

describe('resolveDispatchSessionSelection strict lifecycle', () => {
  it('keeps explicit session id', () => {
    const { deps, sessionManager } = createDeps();
    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-explicit',
      task: 'run',
    } as any);
    expect(result.sessionId).toBe('session-explicit');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('uses bound session when available', () => {
    const { deps, runtime, sessionManager } = createDeps({
      boundSessionId: 'session-bound',
    });
    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      task: 'run',
    } as any);
    expect(result.sessionId).toBe('session-bound');
    expect(result.sessionStrategy).toBe('current');
    expect(runtime.getBoundSessionId).toHaveBeenCalledWith('finger-project-agent');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('falls back to current session and never auto-creates for latest/new strategy', () => {
    const { deps, sessionManager } = createDeps({
      boundSessionId: null,
    });
    const latestResult = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'latest',
      task: 'run latest',
    } as any);
    const newResult = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'new',
      task: 'run new',
    } as any);

    expect(latestResult.sessionId).toBe('session-current');
    expect(newResult.sessionId).toBe('session-current');
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('returns original input when no bound/current session exists', () => {
    const { deps, sessionManager } = createDeps({
      boundSessionId: null,
      runtimeCurrentSessionId: null,
      managerCurrentSessionId: null,
    });
    const input = {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionStrategy: 'latest',
      task: 'run',
    } as any;
    const result = resolveDispatchSessionSelection(deps, input);
    expect(result.sessionId).toBeUndefined();
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it('rebinds explicit system-owned session to project-scoped session when target is project agent', () => {
    const sessions = {
      'system-main': {
        id: 'system-main',
        projectPath: '/Users/fanzhang/.finger/system',
        context: { sessionTier: 'system', ownerAgentId: 'finger-system-agent' },
      },
      'session-project-root': {
        id: 'session-project-root',
        projectPath: '/Volumes/extension/code/finger',
        context: { sessionTier: 'orchestrator-root' },
      },
    };
    const { deps } = createDeps({
      sessions,
      runtimeCurrentSessionId: 'system-main',
      managerCurrentSessionId: 'system-main',
      findSessionsByProjectPathResult: [
        {
          id: 'session-project-root',
          projectPath: '/Volumes/extension/code/finger',
          context: { sessionTier: 'orchestrator-root' },
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });
    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'system-main',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'do work',
      },
    } as any);
    expect(result.sessionId).toBe('session-project-root');
    expect(result.sessionStrategy).toBe('current');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
  });

  it('creates project-scoped session via ensureSession when target project has no existing root session', () => {
    const sessions = {
      'system-main': {
        id: 'system-main',
        projectPath: '/Users/fanzhang/.finger/system',
        context: { sessionTier: 'system', ownerAgentId: 'finger-system-agent' },
      },
    };
    const { deps, sessionManager } = createDeps({
      sessions,
      runtimeCurrentSessionId: 'system-main',
      managerCurrentSessionId: 'system-main',
      findSessionsByProjectPathResult: [],
    });
    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'system-main',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'do work',
      },
    } as any);
    expect(result.sessionId).toMatch(/^dispatch-finger-project-agent-/);
    expect(result.sessionStrategy).toBe('current');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect(sessionManager.ensureSession).toHaveBeenCalledTimes(1);
  });

  it('creates worker-scoped project session when requested worker differs from existing session worker scope', () => {
    const sessions = {
      'session-project-alex': {
        id: 'session-project-alex',
        projectPath: '/Volumes/extension/code/finger',
        context: {
          sessionTier: 'orchestrator-root',
          dispatchTargetAgentId: 'finger-project-agent',
          dispatchProjectPath: '/Volumes/extension/code/finger',
          dispatchScopeKey: 'finger-project-agent::/Volumes/extension/code/finger::finger-project-agent',
          dispatchWorkerId: 'finger-project-agent',
        },
      },
      'session-current': {
        id: 'session-current',
        projectPath: '/Volumes/extension/code/finger',
        context: {
          sessionTier: 'orchestrator-root',
          dispatchTargetAgentId: 'finger-project-agent',
          dispatchProjectPath: '/Volumes/extension/code/finger',
          dispatchScopeKey: 'finger-project-agent::/Volumes/extension/code/finger::finger-project-agent',
          dispatchWorkerId: 'finger-project-agent',
        },
      },
    };
    const { deps, sessionManager } = createDeps({
      sessions,
      runtimeCurrentSessionId: 'session-current',
      managerCurrentSessionId: 'session-current',
      findSessionsByProjectPathResult: [
        {
          id: 'session-project-alex',
          projectPath: '/Volumes/extension/code/finger',
          context: sessions['session-project-alex'].context,
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });

    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
        workerId: 'finger-project-agent-02',
      },
      assignment: {
        assigneeWorkerId: 'finger-project-agent-02',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'parallel worker task',
      },
    } as any);

    expect(result.sessionId).toMatch(/^dispatch-finger-project-agent-/);
    expect(result.sessionStrategy).toBe('current');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect(sessionManager.ensureSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      expect.stringMatching(/^dispatch-finger-project-agent-/),
      expect.objectContaining({
        dispatchWorkerId: 'finger-project-agent-02',
      }),
    );
  });

  it('does not reuse bound project session when bound worker scope is unbound and dispatch requests a concrete worker', () => {
    const sessions = {
      'session-bound-unbound': {
        id: 'session-bound-unbound',
        projectPath: '/Volumes/extension/code/finger',
        context: {
          sessionTier: 'orchestrator-root',
          dispatchTargetAgentId: 'finger-project-agent',
          dispatchProjectPath: '/Volumes/extension/code/finger',
          // legacy/unbound: no dispatchWorkerId
        },
      },
      'session-current': {
        id: 'session-current',
        projectPath: '/Users/fanzhang/.finger/system',
        context: { sessionTier: 'system', ownerAgentId: 'finger-system-agent' },
      },
    };
    const { deps, sessionManager, runtime } = createDeps({
      sessions,
      boundSessionId: 'session-bound-unbound',
      runtimeCurrentSessionId: 'session-current',
      managerCurrentSessionId: 'session-current',
      findSessionsByProjectPathResult: [
        {
          id: 'session-bound-unbound',
          projectPath: '/Volumes/extension/code/finger',
          context: sessions['session-bound-unbound'].context,
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });

    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
        workerId: 'finger-project-agent-02',
      },
      assignment: {
        assigneeWorkerId: 'finger-project-agent-02',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'dispatch to james',
      },
    } as any);

    expect(runtime.getBoundSessionId).toHaveBeenCalledWith('finger-project-agent');
    expect(result.sessionId).toMatch(/^dispatch-finger-project-agent-/);
    expect(result.sessionId).not.toBe('session-bound-unbound');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect(sessionManager.ensureSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      expect.stringMatching(/^dispatch-finger-project-agent-/),
      expect.objectContaining({
        dispatchWorkerId: 'finger-project-agent-02',
      }),
    );
  });

  it('does not reuse current project session when current worker scope is unbound and dispatch requests a concrete worker', () => {
    const sessions = {
      'session-current-unbound': {
        id: 'session-current-unbound',
        projectPath: '/Volumes/extension/code/finger',
        context: {
          sessionTier: 'orchestrator-root',
          dispatchTargetAgentId: 'finger-project-agent',
          dispatchProjectPath: '/Volumes/extension/code/finger',
          // legacy/unbound: no dispatchWorkerId
        },
      },
    };
    const { deps, sessionManager } = createDeps({
      sessions,
      boundSessionId: null,
      runtimeCurrentSessionId: 'session-current-unbound',
      managerCurrentSessionId: 'session-current-unbound',
      findSessionsByProjectPathResult: [
        {
          id: 'session-current-unbound',
          projectPath: '/Volumes/extension/code/finger',
          context: sessions['session-current-unbound'].context,
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });

    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
        workerId: 'finger-project-agent-03',
      },
      assignment: {
        assigneeWorkerId: 'finger-project-agent-03',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'dispatch to robin',
      },
    } as any);

    expect(result.sessionId).toMatch(/^dispatch-finger-project-agent-/);
    expect(result.sessionId).not.toBe('session-current-unbound');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect(sessionManager.ensureSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      expect.stringMatching(/^dispatch-finger-project-agent-/),
      expect.objectContaining({
        dispatchWorkerId: 'finger-project-agent-03',
      }),
    );
  });

  it('rebinds explicit project session when worker scope is unbound but dispatch requests a concrete worker', () => {
    const sessions = {
      'session-project-unbound': {
        id: 'session-project-unbound',
        projectPath: '/Volumes/extension/code/finger',
        context: {
          sessionTier: 'orchestrator-root',
          dispatchTargetAgentId: 'finger-project-agent',
          dispatchProjectPath: '/Volumes/extension/code/finger',
          // legacy/unbound session: no dispatchWorkerId
        },
      },
    };
    const { deps, sessionManager } = createDeps({
      sessions,
      runtimeCurrentSessionId: 'session-project-unbound',
      managerCurrentSessionId: 'session-project-unbound',
      findSessionsByProjectPathResult: [
        {
          id: 'session-project-unbound',
          projectPath: '/Volumes/extension/code/finger',
          context: sessions['session-project-unbound'].context,
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });

    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-project-unbound',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
        workerId: 'finger-project-agent-02',
      },
      assignment: {
        assigneeWorkerId: 'finger-project-agent-02',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'use james worker',
      },
    } as any);

    expect(result.sessionId).toMatch(/^dispatch-finger-project-agent-/);
    expect(result.sessionId).not.toBe('session-project-unbound');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect(sessionManager.ensureSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.updateContext).toHaveBeenCalledWith(
      expect.stringMatching(/^dispatch-finger-project-agent-/),
      expect.objectContaining({
        dispatchWorkerId: 'finger-project-agent-02',
      }),
    );
  });

  it('creates stateless reviewer session for reviewer dispatch by default', () => {
    const sessions = {
      'session-reviewer-webauto': {
        id: 'session-reviewer-webauto',
        projectPath: '/Users/fanzhang/github/webauto',
        context: { sessionTier: 'runtime', ownerAgentId: 'finger-reviewer', rootSessionId: 'root-webauto' },
      },
      'session-finger-root': {
        id: 'session-finger-root',
        projectPath: '/Volumes/extension/code/finger',
        context: { sessionTier: 'orchestrator-root' },
      },
    };
    const { deps, runtime } = createDeps({
      sessions,
      boundSessionId: 'session-reviewer-webauto',
      runtimeCurrentSessionId: 'session-reviewer-webauto',
      managerCurrentSessionId: 'session-reviewer-webauto',
      findSessionsByProjectPathResult: [
        {
          id: 'session-finger-root',
          projectPath: '/Volumes/extension/code/finger',
          context: { sessionTier: 'orchestrator-root' },
          lastAccessedAt: new Date().toISOString(),
        } as any,
      ],
    });

    const result = resolveDispatchSessionSelection(deps, {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-reviewer',
      metadata: {
        projectPath: '/Volumes/extension/code/finger',
      },
      task: {
        cwd: '/Volumes/extension/code/finger',
        prompt: 'review changes',
      },
    } as any);

    expect(runtime.getBoundSessionId).not.toHaveBeenCalled();
    expect(result.sessionId).toMatch(/^review-/);
    expect(result.sessionStrategy).toBe('current');
    expect((result as any).metadata?.dispatchSessionScopeRebound).toBe(true);
    expect((result as any).metadata?.reviewerStateless).toBe(true);
    expect((result as any).metadata?.reviewerEphemeralSession).toBe(true);
  });
});
