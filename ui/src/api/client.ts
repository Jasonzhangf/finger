/**
 * API Client - Finger Daemon REST API 封装
 */

import type {
  DaemonStatus,
  ModuleListResponse,
  RouteInfo,
  MessageResponse,
  SessionInfo,
  WorkflowInfo,
  ProviderConfig,
  AgentStats,
  TaskInfo,
} from './types.js';

const API_BASE = '/api/v1';

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.text().catch(() => 'Unknown error');
    throw new Error(`API Error (${res.status}): ${err}`);
  }
  return res.json() as Promise<T>;
}

// Daemon Status
export async function getDaemonStatus(): Promise<DaemonStatus> {
  return fetchApi<DaemonStatus>('/status');
}

// Modules
export async function listModules(): Promise<ModuleListResponse> {
  return fetchApi<ModuleListResponse>('/modules');
}

export async function listRoutes(): Promise<RouteInfo[]> {
  return fetchApi<RouteInfo[]>('/routes');
}

// Messages
export async function sendMessage<T = unknown>(
  target: string,
  message: unknown,
  options: { blocking?: boolean; sender?: string } = {}
): Promise<MessageResponse<T>> {
  return fetchApi<MessageResponse<T>>('/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target,
      message,
      blocking: options.blocking ?? true,
      sender: options.sender,
    }),
  });
}

// Sessions
export async function listSessions(): Promise<SessionInfo[]> {
  return fetchApi<SessionInfo[]>('/sessions');
}

export async function getSession(sessionId: string): Promise<SessionInfo> {
  return fetchApi<SessionInfo>(`/sessions/${sessionId}`);
}

export async function createSession(projectPath: string, name?: string): Promise<SessionInfo> {
  return fetchApi<SessionInfo>('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, name }),
  });
}

export async function setCurrentSession(sessionId: string): Promise<void> {
  await fetchApi<void>(`/sessions/${sessionId}/current`, { method: 'POST' });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetchApi<void>(`/sessions/${sessionId}`, { method: 'DELETE' });
}

// Workflows
export async function listWorkflows(): Promise<WorkflowInfo[]> {
  return fetchApi<WorkflowInfo[]>('/workflows');
}

export async function getWorkflow(workflowId: string): Promise<WorkflowInfo> {
  return fetchApi<WorkflowInfo>(`/workflows/${workflowId}`);
}

export async function getWorkflowTasks(workflowId: string): Promise<TaskInfo[]> {
  return fetchApi<TaskInfo[]>(`/workflows/${workflowId}/tasks`);
}

// Agent Stats
export async function listAgentStats(): Promise<AgentStats[]> {
  return fetchApi<AgentStats[]>('/agents/stats');
}

export async function getAgentStats(agentId: string): Promise<AgentStats> {
  return fetchApi<AgentStats>(`/agents/${agentId}/stats`);
}

// Providers
export async function listProviders(): Promise<ProviderConfig[]> {
  return fetchApi<ProviderConfig[]>('/providers');
}

export async function testProvider(providerId: string): Promise<{ success: boolean; message: string }> {
  return fetchApi<{ success: boolean; message: string }>(`/providers/${providerId}/test`, { method: 'POST' });
}

// Legacy block API (for compatibility)
export interface BlockInfo {
  type: string;
  id: string;
  capabilities: {
    functions: string[];
    cli: Array<{ name: string; description: string; args: unknown[] }>;
    stateSchema: Record<string, unknown>;
    events?: string[];
  };
  state: {
    id: string;
    type: string;
    status: 'idle' | 'running' | 'error' | 'stopped';
    health: 'healthy' | 'degraded' | 'unhealthy';
    data: Record<string, unknown>;
    updatedAt: string;
  };
}

export async function fetchBlocks(): Promise<BlockInfo[]> {
  const res = await fetch(`${API_BASE}/blocks`);
  if (!res.ok) throw new Error(`Failed to fetch blocks: ${res.status}`);
  return res.json() as Promise<BlockInfo[]>;
}

export async function fetchBlockState(blockId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/blocks/${blockId}/state`);
  if (!res.ok) throw new Error(`Failed to fetch block state: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function executeBlockCommand(
  blockId: string,
  command: string,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/blocks/${blockId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error?: string };
    throw new Error(err.error || 'Unknown error');
  }

  return res.json() as Promise<Record<string, unknown>>;
}
