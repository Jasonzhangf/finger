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
  status?: 'idle' | 'running' | 'error';
  config?: AgentConfig;
  load?: number;
  errorRate?: number;
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

// ========== Workflow Runtime Types ==========

export type WorkflowStatus = 'planning' | 'executing' | 'completed' | 'failed' | 'partial' | 'paused';
export type TaskStatus = 'pending' | 'blocked' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'paused';
export type AgentRuntimeStatus = 'idle' | 'running' | 'error' | 'paused';

export interface WorkflowInfo {
  id: string;
  sessionId: string;
  epicId?: string;
  status: WorkflowStatus;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  createdAt: string;
  updatedAt: string;
  userTask: string;
}

export interface TaskInfo {
  id: string;
  bdTaskId?: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  dependencies: string[];
  result?: {
    success: boolean;
    output?: string;
    error?: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface TaskNode {
  id: string;
  bdTaskId?: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  dependencies: string[];
  result?: {
    success: boolean;
    output?: string;
    error?: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  type: 'executor' | 'reviewer' | 'orchestrator';
  status: AgentRuntimeStatus;
  load: number;
  errorRate: number;
  requestCount: number;
  tokenUsage: number;
  currentTaskId?: string;
  config?: AgentConfig;
  instanceCount?: number;
  version?: string;
}

export interface AgentConfig {
  id?: string;
  name: string;
  mode: 'auto' | 'manual';
  provider: 'iflow' | 'openai' | 'anthropic';
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  maxTurns?: number;
  maxIterations?: number;
  maxRounds?: number;
  enableReview?: boolean;
  cwd?: string;
  resumeSession?: boolean;
}

export interface ExecutionStep {
  round: number;
  action: string;
  thought?: string;
  params?: Record<string, unknown>;
  observation?: string;
  success: boolean;
  timestamp: string;
  duration?: number;
}

export interface AgentExecutionDetail {
  agentId: string;
  agentName: string;
  taskId?: string;
  taskDescription?: string;
  status: AgentRuntimeStatus;
  steps: ExecutionStep[];
  currentRound: number;
  totalRounds: number;
  startTime: string;
  endTime?: string;
  sessionFilePath?: string;
}

export interface WorkflowExecutionState {
  workflowId: string;
  status: WorkflowStatus;
  orchestrator: {
    id: string;
    currentRound: number;
    maxRounds: number;
    thought?: string;
  };
  agents: AgentRuntime[];
  tasks: TaskNode[];
  executionPath: Array<{
    from: string;
    to: string;
    status: 'active' | 'completed' | 'error' | 'pending';
    message?: string;
  }>;
  paused: boolean;
  userInput?: string;
  executionRounds?: ExecutionRound[];
}

export interface ExecutionRound {
  roundId: string;
  timestamp: string;
  agents: AgentRoundInfo[];
  edges: RoundEdgeInfo[];
}

export interface AgentRoundInfo {
  agentId: string;
  status: 'idle' | 'running' | 'error' | 'completed';
  taskId?: string;
  taskDescription?: string;
}

export interface RoundEdgeInfo {
  from: string;
  to: string;
  status: 'active' | 'completed' | 'error' | 'pending';
  message?: string;
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
  type: 'status' | 'task_update' | 'message' | 'error' | 'workflow_update' | 'agent_update' | 'execution_step';
  payload: unknown;
  timestamp: string;
}

export interface RuntimeEvent {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  kind?: 'thought' | 'action' | 'observation' | 'status';
  images?: RuntimeImage[];
}

export interface RuntimeImage {
  id: string;
  name: string;
  url: string;
}

export interface UserRound {
  roundId: string;
  timestamp: string;
  summary: string;
  fullText: string;
  images?: RuntimeImage[];
}

export interface UserInputPayload {
  text: string;
  images?: RuntimeImage[];
}

export interface WorkflowUpdatePayload {
  workflowId: string;
  status: WorkflowStatus;
  orchestratorState?: {
    round: number;
    thought?: string;
    action?: string;
  };
  taskUpdates?: TaskNode[];
  agentUpdates?: AgentRuntime[];
  executionPath?: WorkflowExecutionState['executionPath'];
  userInput?: string;
}

export interface AgentUpdatePayload {
  agentId: string;
  status: AgentRuntimeStatus;
  currentTaskId?: string;
  load: number;
  step?: ExecutionStep;
}

export interface TaskReport {
  workflowId: string;
  epicId?: string;
  userTask: string;
  status: WorkflowStatus;
  summary: {
    totalTasks: number;
    completed: number;
    failed: number;
    success: boolean;
    rounds: number;
    duration: number;
  };
  taskDetails: Array<{
    taskId: string;
    description: string;
    status: TaskStatus;
    assignee?: string;
    output?: string;
    error?: string;
  }>;
  createdAt: string;
  completedAt?: string;
}
