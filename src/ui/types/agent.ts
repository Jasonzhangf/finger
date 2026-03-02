/**
 * Agent types for Canvas UI
 */

export interface AgentStatus {
  status: 'idle' | 'running' | 'success' | 'error';
  currentTaskId?: string;
  currentTaskDescription?: string;
  lastHeartbeat?: string;
  progress?: number; // 0-100
}

export interface AgentExecutionState {
  agentId: string;
  status: AgentStatus['status'];
  currentIteration: number;
  maxIterations: number;
  lastAction?: string;
  lastThought?: string;
  startTime: string;
  endTime?: string;
  error?: string;
}

export interface ExecutionStep {
  timestamp: string;
  agentId: string;
  action: string;
  input?: unknown;
  output?: unknown;
  status: 'success' | 'error' | 'pending';
}

export interface CanvasConnection {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
  status: 'pending' | 'active' | 'completed' | 'error';
  animated?: boolean;
}

export interface SessionCanvasState {
  sessionId: string;
  workflowId?: string;
  agents: AgentNode[];
  connections: CanvasConnection[];
  executionLog: ExecutionStep[];
  startTime: string;
  endTime?: string;
  status: 'running' | 'paused' | 'completed' | 'error';
}

export interface AgentNode {
  id: string;
  type: 'start' | 'end' | 'agent' | 'tool';
  name: string;
  role: 'orchestrator' | 'executor' | 'reviewer' | 'searcher' | 'summary';
  position: { x: number; y: number };
  status: AgentStatus['status'];
  config: AgentConfig;
  execution?: AgentExecutionState;
}

export interface AgentConfig {
  id: string;
  name: string;
  role: AgentNode['role'];
  systemPrompt?: string;
  maxIterations?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: string[];
  capabilities?: string[];
  instanceCount?: number;
  metadata?: Record<string, unknown>;
}
