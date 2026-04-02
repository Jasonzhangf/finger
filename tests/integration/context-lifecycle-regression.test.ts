import { describe, expect, it } from 'vitest';
import path from 'path';
import { SessionManager } from '../../src/orchestration/session-manager.js';
import { __fingerRoleModulesInternals } from '../../src/server/modules/finger-role-modules.js';

describe('Context lifecycle regression', () => {
  it('persists bootstrap once state across SessionManager restart', () => {
    const manager = new SessionManager();
    const session = manager.createSession(
      `/tmp/finger-bootstrap-persist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      'Bootstrap Persist Session',
    );

    const persistedState = {
      version: 1,
      byAgent: {
        'finger-system-agent': {
          lastAttemptAt: '2026-04-02T10:00:00.000Z',
          lastOutcome: 'success',
          lastTrigger: 'history_empty',
          messageCountAtAttempt: 0,
        },
      },
    };
    const updated = manager.updateContext(session.id, {
      contextBuilderBootstrapOnceState: persistedState,
    });
    expect(updated).toBe(true);

    const managerReloaded = new SessionManager();
    const restored = managerReloaded.getSession(session.id);
    expect(restored).toBeDefined();
    const parsed = __fingerRoleModulesInternals.parsePersistedBootstrapOnceState(
      (restored?.context ?? {}) as Record<string, unknown>,
    );
    expect(parsed?.byAgent['finger-system-agent']?.lastOutcome).toBe('success');

    const decision = __fingerRoleModulesInternals.shouldAllowBootstrapFromPersistedState(
      parsed,
      'finger-system-agent',
      0,
      Date.parse('2026-04-02T10:05:00.000Z'),
      120_000,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('already_succeeded');
  });

  it('setCurrentSession does not mutate process cwd globally', () => {
    const manager = new SessionManager();
    const initialCwd = process.cwd();
    const projectPath = path.join('/tmp', `finger-no-chdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const session = manager.createSession(projectPath, 'No Chdir Session');
    const switched = manager.setCurrentSession(session.id);
    expect(switched).toBe(true);
    expect(process.cwd()).toBe(initialCwd);
  });
});

