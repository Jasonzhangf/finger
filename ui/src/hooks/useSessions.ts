import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listSessions,
  createSession,
  deleteSession,
  setCurrentSession,
  renameSession,
} from '../api/client.js';
import type { SessionInfo } from '../api/types.js';

const LAST_SESSION_STORAGE_KEY = 'finger-last-session-id';

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
  const manualSelectionRef = useRef<string | null>(null);

  const sortByRecent = useCallback((items: SessionInfo[]) => {
    return items.slice().sort(
      (a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
    );
  }, []);

  const pickLatestRunning = useCallback((items: SessionInfo[]): SessionInfo | null => {
    const running = items.filter(
      (session) => Array.isArray(session.activeWorkflows) && session.activeWorkflows.length > 0,
    );
    if (running.length === 0) return null;
    return sortByRecent(running)[0] ?? null;
  }, [sortByRecent]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listSessions();
      setSessions(data);
      if (data.length === 0) {
        setCurrent(null);
        return;
      }

      const manualSelection = manualSelectionRef.current;
      if (manualSelection) {
        const matched = data.find((item) => item.id === manualSelection);
        manualSelectionRef.current = null;
        if (matched) {
          setCurrent(matched);
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, matched.id);
          }
          return;
        }
      }

      const latestRunning = pickLatestRunning(data);
      if (latestRunning) {
        setCurrent(latestRunning);
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, latestRunning.id);
        }
        await setCurrentSession(latestRunning.id).catch(() => undefined);
        return;
      }

      const fallback = sortByRecent(data)[0];
      setCurrent(fallback);
      await setCurrentSession(fallback.id).catch(() => undefined);
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, fallback.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  }, [pickLatestRunning, sortByRecent]);

  const create = useCallback(async (projectPath: string, name?: string) => {
    const session = await createSession(projectPath, name);
    manualSelectionRef.current = session.id;
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
    manualSelectionRef.current = sessionId;
    const next = sessions.find((session) => session.id === sessionId);
    if (next) {
      setCurrent(next);
    }
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId);
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
