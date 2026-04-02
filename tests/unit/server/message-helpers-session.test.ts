import { describe, expect, it, vi } from 'vitest';
import {
  ensureSessionExists,
  resolveStableSessionFallbackForUnknownPayload,
} from '../../../src/server/routes/message-helpers.js';

describe('message-helpers ensureSessionExists', () => {
  it('returns true when session exists', () => {
    const sessionManager = {
      getSession: vi.fn(() => ({ id: 'session-1' })),
    } as any;

    const result = ensureSessionExists(sessionManager, 'session-1');
    expect(result).toBe(true);
    expect(sessionManager.getSession).toHaveBeenCalledWith('session-1');
  });

  it('returns false and does not auto-create when session does not exist', () => {
    const sessionManager = {
      getSession: vi.fn(() => undefined),
      ensureSession: vi.fn(),
      createSession: vi.fn(),
    } as any;

    const result = ensureSessionExists(sessionManager, 'missing-session');
    expect(result).toBe(false);
    expect(sessionManager.getSession).toHaveBeenCalledWith('missing-session');
    expect(sessionManager.ensureSession).not.toHaveBeenCalled();
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });
});

describe('message-helpers resolveStableSessionFallbackForUnknownPayload', () => {
  it('returns system session for system route when payload session is unknown', () => {
    const result = resolveStableSessionFallbackForUnknownPayload({
      requestedSessionId: 'missing-session',
      isSystemRoute: true,
      systemSessionId: 'system-main',
      systemProjectPath: '/system',
    });
    expect(result).toBe('system-main');
  });

  it('returns bound session for non-system route when bound session exists', () => {
    const result = resolveStableSessionFallbackForUnknownPayload({
      requestedSessionId: 'missing-session',
      isSystemRoute: false,
      boundSessionId: 'project-bound',
      boundSessionExists: true,
      currentSession: { id: 'project-current', projectPath: '/repo/project-a' },
      systemProjectPath: '/system',
    });
    expect(result).toBe('project-bound');
  });

  it('returns current non-system session when bound session is unavailable', () => {
    const result = resolveStableSessionFallbackForUnknownPayload({
      requestedSessionId: 'missing-session',
      isSystemRoute: false,
      boundSessionId: 'project-bound',
      boundSessionExists: false,
      currentSession: { id: 'project-current', projectPath: '/repo/project-a' },
      systemProjectPath: '/system',
    });
    expect(result).toBe('project-current');
  });

  it('returns null when only system current session is available', () => {
    const result = resolveStableSessionFallbackForUnknownPayload({
      requestedSessionId: 'missing-session',
      isSystemRoute: false,
      boundSessionId: null,
      boundSessionExists: false,
      currentSession: { id: 'system-main', projectPath: '/system' },
      systemProjectPath: '/system',
    });
    expect(result).toBeNull();
  });
});
