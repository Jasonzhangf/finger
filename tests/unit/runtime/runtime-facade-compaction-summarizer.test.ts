import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeFacade, type ISessionManager, type SessionInfo } from '../../../src/runtime/runtime-facade.js';
import { RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE } from '../../../src/runtime/kernel-owned-compaction.js';

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

function createRuntimeWithSessionManager(sessionManager: ISessionManager) {
  const eventBus = {
    emit: vi.fn(async () => undefined),
    subscribe: vi.fn(),
    subscribeMultiple: vi.fn(),
    enablePersistence: vi.fn(),
  } as any;
  const toolRegistry = createToolRegistryStub() as any;
  return {
    runtime: new RuntimeFacade(eventBus, sessionManager, toolRegistry),
    eventBus,
  };
}

function createSessionStub(sessionId = 'session-compact-1'): SessionInfo {
  return {
    id: sessionId,
    name: 'compact-session',
    projectPath: '/tmp/project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 12,
    context: {
      ownerAgentId: 'finger-system-agent',
      sessionTier: 'main',
    },
  };
}

describe('RuntimeFacade compact ownership regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('manual compact rejects with explicit Rust-only ownership error and emits no session_compressed event', async () => {
    const session = createSessionStub('session-compact-manual');
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => []),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async () => 'should-not-run'),
      updateContext: vi.fn(() => true),
    };
    const { runtime, eventBus } = createRuntimeWithSessionManager(sessionManager);

    await expect(runtime.compressContext(session.id, { trigger: 'manual' }))
      .rejects.toThrow(RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE);

    expect(sessionManager.compressContext).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_compressed' }));
  });

  it('auto compact probe is a no-op and never falls back to TS session manager compact', async () => {
    const session = createSessionStub('session-compact-auto');
    const sessionManager: ISessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(() => session),
      getCurrentSession: vi.fn(() => null),
      setCurrentSession: vi.fn(() => true),
      listSessions: vi.fn(() => [session]),
      addMessage: vi.fn(async () => null),
      getMessages: vi.fn(() => []),
      deleteSession: vi.fn(() => true),
      compressContext: vi.fn(async () => 'should-not-run'),
      updateContext: vi.fn(() => true),
    };
    const { runtime } = createRuntimeWithSessionManager(sessionManager);

    await expect(runtime.maybeAutoCompact(session.id, 97, 'resp-1')).resolves.toBe(false);
    expect(sessionManager.compressContext).not.toHaveBeenCalled();
  });
});
