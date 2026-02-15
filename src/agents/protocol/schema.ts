// Agent Communication Protocol Schema
// Based on ReACT pattern: Thought → Action → Observation

export type MessageMode = 'plan' | 'execute' | 'review' | 'test' | 'ask';
export type MessageStatus = 'pending' | 'sent' | 'running' | 'completed' | 'failed' | 'timeout';
export type ExecutionMode = 'sync' | 'async';

export interface ProtocolMessageMeta {
  traceId?: string;
  parentMessageId?: string;
  createdBy?: string;
}

export interface ProtocolMessageTiming {
  createdAt: string;
  deadlineAt?: string;
  executionTimeMs?: number;
}

export interface TaskDefinition {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
}

export interface ToolSpec {
  name: string;
  argsSchema?: Record<string, unknown>;
}

export interface TaskStatusPayload {
  state: MessageStatus;
  detail?: string;
}

export interface TaskResultPayload {
  success: boolean;
  output: string;
  error?: string;
}

export interface AskPayload {
  question: string;
  required?: boolean;
}

export interface ProtocolEnvelope {
  sender: string;
  receiver: string;
  mode: MessageMode;
  task: TaskDefinition;
  tools: ToolSpec[];
  timing: ProtocolMessageTiming;
  status: TaskStatusPayload;
  result?: TaskResultPayload;
  ask?: AskPayload;
  meta?: ProtocolMessageMeta;
}

export interface AgentMessage {
  id: string;
  timestamp: string;
  sender: string;
  receiver: string;
  mode: MessageMode;
  status: MessageStatus;
  executionTime?: number;
  payload: MessagePayload;
  envelope?: ProtocolEnvelope;
}

export interface MessagePayload {
  task?: TaskAssignment;
  feedback?: ExecutionFeedback;
  tool?: ToolAssignment;
}

export interface TaskAssignment {
  taskId: string;
  bdTaskId?: string;
  description: string;
  tools: string[];
  deadline?: number;
  priority: number;
  thought?: string;
  action?: string;
}

export interface ExecutionFeedback {
  taskId: string;
  success: boolean;
  result: string;
  observation?: string;
  metrics?: ExecutionMetrics;
}

export interface ExecutionMetrics {
  duration: number;
  tokenUsage?: number;
  retryCount?: number;
}

export interface ToolAssignment {
  toolName: string;
  action: 'grant' | 'revoke';
  constraints?: Record<string, unknown>;
}

export interface OrchestratorRelation {
  orchestratorId: string;
  executors: string[];
  createdAt: string;
}

export const createMessage = (
  sender: string,
  receiver: string,
  mode: MessageMode,
  payload: MessagePayload
): AgentMessage => ({
  id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
  timestamp: new Date().toISOString(),
  sender,
  receiver,
  mode,
  status: 'pending',
  payload,
});
