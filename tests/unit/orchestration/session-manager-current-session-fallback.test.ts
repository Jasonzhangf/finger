import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../../../src/orchestration/session-manager.js';

describe('SessionManager current session fallback', () => {
  it('keeps current session binding even when cwd apply fails', () => {
    const manager = new SessionManager();
    const projectPath = `/tmp/finger-session-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = manager.createSession(projectPath, 'Fallback Session');

    const chdirSpy = vi.spyOn(process, 'chdir').mockImplementation(() => {
      throw new Error('mock chdir failure');
    });
    try {
      const switched = manager.setCurrentSession(session.id);
      expect(switched).toBe(true);
      expect(manager.getCurrentSession()?.id).toBe(session.id);
    } finally {
      chdirSpy.mockRestore();
    }
  });
});

