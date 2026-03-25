import { fetchApi } from './client.js';

export interface HeartbeatStatusResponse {
  success: boolean;
  enabled: boolean;
  intervalMs: number;
  dispatch: 'mailbox' | 'dispatch' | string;
  projects?: Record<string, { enabled?: boolean }>;
  taskStats?: { pending: number; completed: number; total: number };
}

export interface HeartbeatTaskItem {
  text?: string;
  section?: string;
  status?: 'pending' | 'completed';
  ts?: string;
}

export interface HeartbeatTaskListResponse {
  success: boolean;
  tasks: HeartbeatTaskItem[];
}

export async function getHeartbeatStatus(): Promise<HeartbeatStatusResponse> {
  return fetchApi<HeartbeatStatusResponse>('/heartbeat/status');
}

export async function enableHeartbeat(payload: { intervalMs?: number; dispatch?: 'mailbox' | 'dispatch' }): Promise<{ success: boolean; message?: string; intervalMs?: number; dispatch?: string }> {
  return fetchApi('/heartbeat/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function disableHeartbeat(payload: { projectId?: string } = {}): Promise<{ success: boolean; message?: string }> {
  return fetchApi('/heartbeat/disable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function listHeartbeatTasks(status: 'pending' | 'completed' | 'all' = 'all'): Promise<HeartbeatTaskListResponse> {
  return fetchApi<HeartbeatTaskListResponse>(`/heartbeat/tasks?status=${encodeURIComponent(status)}`);
}

export async function addHeartbeatTask(payload: { text: string; section?: string }): Promise<{ success: boolean; message?: string }> {
  return fetchApi('/heartbeat/tasks/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function completeHeartbeatTask(payload: { text: string }): Promise<{ success: boolean; message?: string }> {
  return fetchApi('/heartbeat/tasks/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function removeHeartbeatTask(payload: { text: string }): Promise<{ success: boolean; message?: string }> {
  return fetchApi('/heartbeat/tasks/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
