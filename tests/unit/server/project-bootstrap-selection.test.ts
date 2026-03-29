import { describe, expect, it } from 'vitest';
import type { SessionManager } from '../../../src/orchestration/session-manager.js';
import type { Session } from '../../../src/orchestration/session-types.js';
import { selectLatestExactProjectRootSession } from '../../../src/server/routes/projects.js';

function makeSession(overrides: Partial<Session>): Session {
  const now = '2026-03-29T00:00:00.000Z';
  return {
    id: overrides.id || 'session-1',
    name: overrides.name || 'session',
    projectPath: overrides.projectPath || '/tmp/project',
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    lastAccessedAt: overrides.lastAccessedAt || now,
    messages: overrides.messages || [],
    activeWorkflows: overrides.activeWorkflows || [],
    context: overrides.context || {},
    ledgerPath: overrides.ledgerPath || '',
    latestCompactIndex: overrides.latestCompactIndex ?? -1,
    originalStartIndex: overrides.originalStartIndex ?? 0,
    originalEndIndex: overrides.originalEndIndex ?? 0,
    totalTokens: overrides.totalTokens ?? 0,
  };
}

describe('selectLatestExactProjectRootSession', () => {
  it('returns latest root session for exact project path', () => {
    const projectPath = '/repo/demo';
    const sessions = [
      makeSession({ id: 'older-root', projectPath, lastAccessedAt: '2026-03-28T00:00:00.000Z' }),
      makeSession({
        id: 'runtime-ignored',
        projectPath,
        lastAccessedAt: '2026-03-29T09:00:00.000Z',
        context: { sessionTier: 'runtime' },
      }),
      makeSession({ id: 'newer-root', projectPath, lastAccessedAt: '2026-03-29T10:00:00.000Z' }),
      makeSession({ id: 'other-path', projectPath: '/repo/other', lastAccessedAt: '2026-03-29T11:00:00.000Z' }),
    ];
    const manager = {
      listRootSessions: () => sessions,
    } as unknown as SessionManager;

    const picked = selectLatestExactProjectRootSession(manager, projectPath);
    expect(picked?.id).toBe('newer-root');
  });

  it('returns null when no exact match', () => {
    const sessions = [
      makeSession({ id: 's1', projectPath: '/repo/a' }),
      makeSession({ id: 's2', projectPath: '/repo/b' }),
    ];
    const manager = {
      listRootSessions: () => sessions,
    } as unknown as SessionManager;

    const picked = selectLatestExactProjectRootSession(manager, '/repo/c');
    expect(picked).toBeNull();
  });
});
