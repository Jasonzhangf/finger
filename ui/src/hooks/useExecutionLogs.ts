import { useState, useEffect, useCallback } from 'react';

export interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  startTime: string;
  endTime?: string;
  success: boolean;
  iterations: Array<{
    round: number;
    action: string;
    thought?: string;
    params?: Record<string, unknown>;
    observation?: string;
    success: boolean;
    timestamp: string;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
  stopReason?: string;
}

interface UseExecutionLogsReturn {
  logs: SessionLog[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getLogByAgentId: (agentId: string) => SessionLog | undefined;
  getLatestLog: () => SessionLog | undefined;
}

export function useExecutionLogs(refreshInterval = 2000): UseExecutionLogsReturn {
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/execution-logs');
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load execution logs');
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    await fetchLogs();
    setIsLoading(false);
  }, [fetchLogs]);

  useEffect(() => {
    refresh();
    
    // Poll for updates
    const interval = setInterval(fetchLogs, refreshInterval);
    return () => clearInterval(interval);
  }, [refresh, fetchLogs, refreshInterval]);

  const getLogByAgentId = useCallback((agentId: string) => {
    return logs.find(log => log.agentId === agentId);
  }, [logs]);

  const getLatestLog = useCallback(() => {
    return logs[0];
  }, [logs]);

  return {
    logs,
    isLoading,
    error,
    refresh,
    getLogByAgentId,
    getLatestLog,
  };
}
