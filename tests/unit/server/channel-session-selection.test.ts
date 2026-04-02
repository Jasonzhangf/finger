import { describe, expect, it, vi } from 'vitest';
import { resolveSessionForChannelTarget } from '../../../src/server/modules/channel-bridge-hub-route-helpers.js';

describe('resolveSessionForChannelTarget', () => {
  it('uses and pins system session for system agent', () => {
    const ensureSession = vi.fn();
    const sessionManager = {
      getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
      ensureSession,
    } as any;
    const channelContextManager = {
      getPinnedSession: vi.fn(() => null),
      pinSession: vi.fn(),
    } as any;

    const result = resolveSessionForChannelTarget({
      sessionManager,
      channelContextManager,
      targetAgentId: 'finger-system-agent',
      channelId: 'qqbot',
    });

    expect(result.sessionId).toBe('system-main');
    expect(sessionManager.getOrCreateSystemSession).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledWith('system-main', expect.any(String), 'channel:qqbot');
    expect(channelContextManager.pinSession).toHaveBeenCalledWith('qqbot', 'finger-system-agent', 'system-main');
  });

  it('reuses pinned session when available', () => {
    const sessionManager = {
      getSession: vi.fn(() => ({ id: 'pinned-1', projectPath: '/repo/a' })),
      getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
    } as any;
    const channelContextManager = {
      getPinnedSession: vi.fn(() => 'pinned-1'),
      pinSession: vi.fn(),
    } as any;

    const result = resolveSessionForChannelTarget({
      sessionManager,
      channelContextManager,
      targetAgentId: 'finger-project-agent',
      channelId: 'qqbot',
      channelContext: { projectPath: '/repo/a' },
    });

    expect(result).toEqual({ sessionId: 'pinned-1', projectPath: '/repo/a' });
    expect(sessionManager.getSession).toHaveBeenCalledWith('pinned-1');
    expect(channelContextManager.pinSession).not.toHaveBeenCalled();
  });

  it('creates deterministic stable session id via ensureSession when no pinned/owned session exists', () => {
    const sessionStore = new Map<string, { id: string }>();
    const ensureSession = vi.fn((sessionId: string) => {
      if (!sessionStore.has(sessionId)) {
        sessionStore.set(sessionId, { id: sessionId });
      }
    });
    const createSession = vi.fn(() => ({ id: 'created-random' }));
    const sessionManager = {
      listSessions: vi.fn(() => []),
      getSession: vi.fn((id: string) => sessionStore.get(id) ?? null),
      ensureSession,
      createSession,
      getOrCreateSystemSession: vi.fn(() => ({ id: 'system-main' })),
      getCurrentSession: vi.fn(() => ({ id: 'curr-1', projectPath: '/repo/webauto' })),
    } as any;
    const channelContextManager = {
      getPinnedSession: vi.fn(() => null),
      pinSession: vi.fn(),
    } as any;

    const result = resolveSessionForChannelTarget({
      sessionManager,
      channelContextManager,
      targetAgentId: 'finger-project-agent',
      channelId: 'qqbot',
      channelContext: { projectPath: '/repo/webauto' },
    });

    expect(result.projectPath).toBe('/repo/webauto');
    expect(result.sessionId.startsWith('chan-qqbot-finger-project-agent-')).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(channelContextManager.pinSession).toHaveBeenCalledWith('qqbot', 'finger-project-agent', result.sessionId);
  });
});
