import { useState, useEffect, useCallback } from 'react';
import {
  listSessions,
  createSession,
  deleteSession,
  setCurrentSession,
  getCurrentSession,
  renameSession,
} from '../api/client.js';
import type { SessionInfo } from '../api/types.js';

interface UseSessionsReturn {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (projectPath: string, name?: string) => Promise<SessionInfo>;
  remove: (sessionId: string) => Promise<void>;
  rename: (sessionId: string, name: string) => Promise<SessionInfo>;
  switchSession: (sessionId: string) => Promise<void>;
}

export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [currentSession, setCurrent] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [data, serverCurrent] = await Promise.all([
        listSessions(),
        getCurrentSession().catch(() => null),
      ]);
      setSessions(data);
      if (serverCurrent && data.some((item) => item.id === serverCurrent.id)) {
        setCurrent(serverCurrent);
        return;
      }
      if (data.length === 0) {
        setCurrent(null);
        return;
      }
      const sorted = [...data].sort(
        (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
      );
      setCurrent(sorted[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const create = useCallback(async (projectPath: string, name?: string) => {
    const session = await createSession(projectPath, name);
    await refresh();
    return session;
  }, [refresh]);

  const remove = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    await refresh();
  }, [refresh]);

  const rename = useCallback(async (sessionId: string, name: string) => {
    const session = await renameSession(sessionId, name);
    await refresh();
    return session;
  }, [refresh]);

  const switchSession = useCallback(async (sessionId: string) => {
    await setCurrentSession(sessionId);
    const next = sessions.find((session) => session.id === sessionId);
    if (next) {
      setCurrent(next);
    }
    await refresh();
  }, [refresh, sessions]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    sessions,
    currentSession,
    isLoading,
    error,
    refresh,
    create,
    remove,
    rename,
    switchSession,
  };
}
