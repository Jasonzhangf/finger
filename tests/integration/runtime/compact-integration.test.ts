import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeFacade } from '../../../src/runtime/runtime-facade.js';
import { RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE } from '../../../src/runtime/kernel-owned-compaction.js';

describe('Compact integration (Rust-only ownership)', () => {
  const session = {
    id: 'integration-compact-session',
    name: 'integration-compact-session',
    projectPath: '/tmp/project',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 2,
    context: {
      ownerAgentId: 'finger-system-agent',
      sessionTier: 'main',
    },
  };

  const sessionManager = {
    createSession: vi.fn(),
    getSession: vi.fn(() => session),
    getCurrentSession: vi.fn(() => session),
    setCurrentSession: vi.fn(() => true),
    listSessions: vi.fn(() => [session]),
    addMessage: vi.fn(async () => null),
    getMessages: vi.fn(() => [
      { id: 'u1', role: 'user', content: 'hello', timestamp: new Date().toISOString() },
      { id: 'a1', role: 'assistant', content: 'world', timestamp: new Date().toISOString() },
    ]),
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('manual compact request fails fast without falling back to TS session mutation path', async () => {
    const runtime = new RuntimeFacade(eventBus, sessionManager as any, toolRegistry);

    await expect(runtime.compressContext(session.id, { trigger: 'manual' }))
      .rejects.toThrow(RUST_KERNEL_COMPACTION_OWNERSHIP_MESSAGE);

    expect(sessionManager.compressContext).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'session_compressed' }));
  });
});
