import { describe, expect, it } from 'vitest';
import { SessionManager } from '../../../src/orchestration/session-manager.js';
import { SYSTEM_PROJECT_PATH } from '../../../src/agents/finger-system-agent/index.js';

function createHeartbeatControlSession(manager: SessionManager, suffix: string): string {
  const heartbeatSessionId = `hb-session-finger-system-agent-global-${suffix}`;
  manager.ensureSession(heartbeatSessionId, SYSTEM_PROJECT_PATH, `[hb] finger-system-agent ${suffix}`);
  manager.updateContext(heartbeatSessionId, {
    sessionTier: 'heartbeat-control',
    ownerAgentId: 'finger-system-agent',
    controlPath: 'heartbeat',
    controlSession: true,
    userInputAllowed: false,
  });
  manager.setCurrentSession(heartbeatSessionId);
  return heartbeatSessionId;
}

describe('SessionManager heartbeat/session isolation guards', () => {
  it('getOrCreateSystemSession never returns heartbeat-control sessions', () => {
    const manager = new SessionManager();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const heartbeatSessionId = createHeartbeatControlSession(manager, suffix);

    const selected = manager.getOrCreateSystemSession();

    expect(selected.id).not.toBe(heartbeatSessionId);
    expect(selected.id.startsWith('hb-session-')).toBe(false);

    manager.deleteSession(heartbeatSessionId);
  });

  it('auto-resume does not bind current session to heartbeat-control session', () => {
    const manager = new SessionManager();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const heartbeatSessionId = createHeartbeatControlSession(manager, suffix);

    const reloaded = new SessionManager();
    const current = reloaded.getCurrentSession();

    expect(current).toBeTruthy();
    expect(current?.id).not.toBe(heartbeatSessionId);
    expect((current?.id ?? '').startsWith('hb-session-')).toBe(false);

    reloaded.deleteSession(heartbeatSessionId);
  });
});

