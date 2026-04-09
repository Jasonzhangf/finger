import { describe, expect, it, vi } from 'vitest';

import { RuntimeFacade, type ISessionManager, type SessionInfo } from '../../../src/runtime/runtime-facade.js';

function createSession(sessionId: string): SessionInfo {
  return {
    id: sessionId,
    name: sessionId,
    projectPath: '/tmp/project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: {
      ownerAgentId: 'finger-system-agent',
      sessionTier: 'main',
    },
  };
}

function createRuntime(session: SessionInfo) {
  const sessionManager: ISessionManager = {
    createSession: vi.fn(),
    getSession: vi.fn(() => session),
    getCurrentSession: vi.fn(() => session),
    setCurrentSession: vi.fn(() => true),
    listSessions: vi.fn(() => [session]),
    addMessage: vi.fn(async () => null),
    getMessages: vi.fn(() => []),
    deleteSession: vi.fn(() => true),
    compressContext: vi.fn(async () => 'should-not-run'),
  };
  const eventBus = {
    emit: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    subscribeMultiple: vi.fn(),
    enablePersistence: vi.fn(),
  } as any;
  const toolRegistry = {
    execute: vi.fn(async () => ({ ok: true })),
    getPolicy: vi.fn(() => 'allow'),
    register: vi.fn(),
    list: vi.fn(() => []),
    setPolicy: vi.fn(() => true),
    isAvailable: vi.fn(() => true),
  } as any;

  return {
    runtime: new RuntimeFacade(eventBus, sessionManager, toolRegistry),
    sessionManager,
    eventBus,
  };
}

describe('auto compact ownership regression', () => {
  it('returns false for high context usage and does not emit fake compact success', async () => {
    const session = createSession('auto-compact-kernel-owned');
    const { runtime, sessionManager, eventBus } = createRuntime(session);

    await expect(runtime.maybeAutoCompact(session.id, 100, 'turn-1')).resolves.toBe(false);

    expect(sessionManager.compressContext).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_compressed' }));
  });

  it('returns false for invalid session or invalid percent without touching session manager', async () => {
    const session = createSession('auto-compact-invalid');
    const { runtime, sessionManager } = createRuntime(session);

    await expect(runtime.maybeAutoCompact('', 90, 'turn-1')).resolves.toBe(false);
    await expect(runtime.maybeAutoCompact(session.id, Number.NaN, 'turn-2')).resolves.toBe(false);

    expect(sessionManager.compressContext).not.toHaveBeenCalled();
  });
});
