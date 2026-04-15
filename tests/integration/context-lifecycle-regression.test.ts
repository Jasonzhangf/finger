import { describe, expect, it } from 'vitest';
import path from 'path';
import { SessionManager } from '../../src/orchestration/session-manager.js';

describe('Context lifecycle regression', () => {

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

