import { useState, useEffect, useCallback } from 'react';
import { listSessions, createSession, deleteSession, setCurrentSession } from '../api/client.js';
import type { SessionInfo } from '../api/types.js';

interface UseSessionsReturn {
  sessions: SessionInfo[];
  currentSession: SessionInfo | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  create: (projectPath: string, name?: string) => Promise<SessionInfo>;
  remove: (sessionId: string) => Promise<void>;
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
      const data = await listSessions();
      setSessions(data);
      // Set most recent as current if available
      if (data.length > 0) {
        const sorted = [...data].sort(
          (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
        );
        setCurrent(sorted[0]);
      }
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

  const switchSession = useCallback(async (sessionId: string) => {
    await setCurrentSession(sessionId);
    await refresh();
  }, [refresh]);

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
    switchSession,
  };
}
