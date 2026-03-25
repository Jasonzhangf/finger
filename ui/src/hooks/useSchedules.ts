import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getHeartbeatStatus,
  listHeartbeatTasks,
  enableHeartbeat,
  disableHeartbeat,
  addHeartbeatTask,
  completeHeartbeatTask,
  removeHeartbeatTask,
  type HeartbeatTaskItem,
  type HeartbeatStatusResponse,
} from '../api/heartbeat.js';
import { listClockTimers, createClockTimer, fetchApi, type ClockTimer } from '../api/client.js';

export interface UseSchedulesReturn {
  clockTimers: ClockTimer[];
  heartbeatTasks: HeartbeatTaskItem[];
  heartbeatStatus: HeartbeatStatusResponse | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createClock: (payload: Parameters<typeof createClockTimer>[0]) => Promise<{ success: boolean; error?: string }>;
  updateClock: (payload: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>;
  cancelClock: (timerId: string) => Promise<{ success: boolean; error?: string }>;
  setHeartbeat: (payload: { intervalMs?: number; dispatch?: 'mailbox' | 'dispatch'; enabled: boolean }) => Promise<{ success: boolean; error?: string }>;
  addTask: (payload: { text: string; section?: string }) => Promise<{ success: boolean; error?: string }>;
  completeTask: (text: string) => Promise<{ success: boolean; error?: string }>;
  removeTask: (text: string) => Promise<{ success: boolean; error?: string }>;
  groupedClockTimers: Map<string, ClockTimer[]>;
}

export function useSchedules(): UseSchedulesReturn {
  const [clockTimers, setClockTimers] = useState<ClockTimer[]>([]);
  const [heartbeatTasks, setHeartbeatTasks] = useState<HeartbeatTaskItem[]>([]);
  const [heartbeatStatus, setHeartbeatStatus] = useState<HeartbeatStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [clock, hbStatus, hbTasks] = await Promise.all([
        listClockTimers(),
        getHeartbeatStatus(),
        listHeartbeatTasks('all'),
      ]);
      setClockTimers(Array.isArray(clock.timers) ? clock.timers : []);
      setHeartbeatStatus(hbStatus);
      setHeartbeatTasks(Array.isArray(hbTasks.tasks) ? hbTasks.tasks : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createClock = useCallback(async (payload: Parameters<typeof createClockTimer>[0]) => {
    try {
      const result = await createClockTimer(payload);
      if (!result.success) return { success: false, error: result.error || 'create failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const updateClock = useCallback(async (payload: Record<string, unknown>) => {
    try {
      const result = await fetchApi<{ success: boolean; error?: string }>('/clock/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!result.success) return { success: false, error: result.error || 'update failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const cancelClock = useCallback(async (timerId: string) => {
    try {
      const result = await fetchApi<{ success: boolean; error?: string }>('/clock/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timer_id: timerId }),
      });
      if (!result.success) return { success: false, error: result.error || 'cancel failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const setHeartbeat = useCallback(async (payload: { intervalMs?: number; dispatch?: 'mailbox' | 'dispatch'; enabled: boolean }) => {
    try {
      const result = payload.enabled
        ? await enableHeartbeat({ intervalMs: payload.intervalMs, dispatch: payload.dispatch })
        : await disableHeartbeat();
      if (!result.success) return { success: false, error: 'heartbeat operation failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const addTask = useCallback(async (payload: { text: string; section?: string }) => {
    try {
      const result = await addHeartbeatTask(payload);
      if (!result.success) return { success: false, error: result.message || 'add task failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const completeTask = useCallback(async (text: string) => {
    try {
      const result = await completeHeartbeatTask({ text });
      if (!result.success) return { success: false, error: result.message || 'complete task failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  const removeTask = useCallback(async (text: string) => {
    try {
      const result = await removeHeartbeatTask({ text });
      if (!result.success) return { success: false, error: result.message || 'remove task failed' };
      await refresh();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const groupedClockTimers = useMemo(() => {
    const map = new Map<string, ClockTimer[]>();
    for (const timer of clockTimers) {
      const key = timer.inject?.projectPath || 'system';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(timer);
    }
    return map;
  }, [clockTimers]);

  return {
    clockTimers,
    heartbeatTasks,
    heartbeatStatus,
    isLoading,
    error,
    refresh,
    createClock,
    updateClock,
    cancelClock,
    setHeartbeat,
    addTask,
    completeTask,
    removeTask,
    groupedClockTimers,
  };
}
