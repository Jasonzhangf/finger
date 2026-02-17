/**
 * Session Resume Hook - 会话恢复管理
 */

import { useState, useCallback } from 'react';

export interface ResumeContext {
  checkpoint: {
    checkpointId: string;
    sessionId: string;
    timestamp: string;
    originalTask: string;
    completedTaskIds: string[];
    failedTaskIds: string[];
    pendingTaskIds: string[];
  };
  summary: string;
  nextActions: string[];
  estimatedProgress: number;
}

interface UseSessionResumeReturn {
  isChecking: boolean;
  hasResumeableSession: boolean | null;
  resumeContext: ResumeContext | null;
  error: string | null;
  checkForResumeableSession: (sessionId: string) => Promise<boolean>;
  resumeSession: (sessionId: string, checkpointId?: string) => Promise<ResumeContext | null>;
  createCheckpoint: (sessionId: string, data: {
    originalTask: string;
    taskProgress: unknown[];
    agentStates?: Record<string, unknown>;
    context?: Record<string, unknown>;
  }) => Promise<string | null>;
}

export function useSessionResume(): UseSessionResumeReturn {
  const [isChecking, setIsChecking] = useState(false);
  const [hasResumeableSession, setHasResumeableSession] = useState<boolean | null>(null);
  const [resumeContext, setResumeContext] = useState<ResumeContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkForResumeableSession = useCallback(async (sessionId: string): Promise<boolean> => {
    setIsChecking(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/session/${sessionId}/checkpoint/latest`);
      if (res.status === 404) {
        setHasResumeableSession(false);
        return false;
      }
      if (!res.ok) throw new Error('Failed to check resume status');
      const data = await res.json();
      setResumeContext(data.resumeContext);
      setHasResumeableSession(data.resumeContext.estimatedProgress < 100);
      return data.resumeContext.estimatedProgress < 100;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Check failed');
      return false;
    } finally {
      setIsChecking(false);
    }
  }, []);

  const resumeSession = useCallback(async (sessionId: string, checkpointId?: string): Promise<ResumeContext | null> => {
    setIsChecking(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/session/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, checkpointId }),
      });
      if (!res.ok) throw new Error('Resume failed');
      const data = await res.json();
      setResumeContext(data.resumeContext);
      return data.resumeContext;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resume failed');
      return null;
    } finally {
      setIsChecking(false);
    }
  }, []);

  const createCheckpoint = useCallback(async (
    sessionId: string,
    data: {
      originalTask: string;
      taskProgress: unknown[];
      agentStates?: Record<string, unknown>;
      context?: Record<string, unknown>;
    }
  ): Promise<string | null> => {
    try {
      const res = await fetch('/api/v1/session/checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...data }),
      });
      if (!res.ok) throw new Error('Checkpoint creation failed');
      const result = await res.json();
      return result.checkpointId;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkpoint failed');
      return null;
    }
  }, []);

  return {
    isChecking,
    hasResumeableSession,
    resumeContext,
    error,
    checkForResumeableSession,
    resumeSession,
    createCheckpoint,
  };
}
