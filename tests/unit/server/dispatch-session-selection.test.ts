import { describe, expect, it, vi } from 'vitest';
import { resolveDispatchSessionSelection } from '../../../src/server/modules/agent-runtime/dispatch-runtime-helpers.js';

function createDeps(overrides?: {
  boundSessionId?: string | null;
  runtimeCurrentSessionId?: string | null;
  managerCurrentSessionId?: string | null;
  sessions?: Record<string, { id: string; projectPath: string; context?: Record<string, unknown> }>;
}) {
  const sessions = overrides?.sessions ?? {
    'session-current': { id: 'session-current', projectPath: '/repo/project-a', context: {} },
    'session-bound': { id: 'session-bound', projectPath: '/repo/project-a', context: {} },
  };
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
    findSessionsByProjectPath: vi.fn(() => []),
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
});
