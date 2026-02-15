/**
 * API Types - Finger Daemon 接口类型定义
 */

export interface DaemonStatus {
  status: 'running' | 'stopped';
  pid?: number;
  port: number;
  uptime?: number;
}

export interface ModuleInfo {
  id: string;
  type: 'input' | 'output' | 'agent';
  name: string;
  version: string;
  metadata?: Record<string, unknown>;
}

export interface ModuleListResponse {
  inputs: ModuleInfo[];
  outputs: ModuleInfo[];
  agents: ModuleInfo[];
  modules: ModuleInfo[];
}

export interface RouteInfo {
  id: string;
  pattern: string;
  target: string;
  priority: number;
  description?: string;
}

export interface SendMessageRequest {
  target: string;
  message: unknown;
  blocking?: boolean;
  sender?: string;
}

export interface MessageResponse<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
  messageId?: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  messageCount: number;
  activeWorkflows: string[];
}

export interface WorkflowInfo {
  id: string;
  sessionId: string;
  epicId?: string;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'partial';
  taskCount: number;
  completedTasks: number;
  createdAt: string;
  updatedAt: string;
}

export type ProviderType = 'iflow' | 'openai' | 'anthropic' | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  status: 'connected' | 'disconnected' | 'error';
}

export interface TaskInfo {
  id: string;
  bdTaskId?: string;
  description: string;
  status: 'pending' | 'blocked' | 'ready' | 'in_progress' | 'completed' | 'failed';
  assignee?: string;
  dependencies: string[];
  result?: unknown;
  error?: string;
}

export interface AgentStats {
  id: string;
  name: string;
  type: 'executor' | 'reviewer' | 'orchestrator';
  status: 'idle' | 'running' | 'error';
  load: number;
  errorRate: number;
  requestCount: number;
  tokenUsage: number;
  workTime: number;
}

export interface WsMessage {
  type: 'status' | 'task_update' | 'message' | 'error';
  payload: unknown;
  timestamp: string;
}
