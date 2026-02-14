// Core types for finger - Agent Orchestrator

// Task-related types
export interface Task {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: TaskStatus;
  isMainPath: boolean;
  dependencies: string[];
  assignedAgent?: string;
  createdAt: Date;
  updatedAt: Date;
  retryCount: number;
  artifacts: Artifact[];
}

export type TaskStatus = 
  | 'open' 
  | 'in_progress' 
  | 'blocked' 
  | 'failed' 
  | 'review' 
  | 'escalated' 
  | 'closed';

export interface Artifact {
  type: 'file' | 'doc' | 'code';
  path: string;
  checksum?: string;
  description: string;
}

// Agent-related types
export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  specialistType?: SpecialistType;
  sdk: 'iflow' | 'codex' | 'claude';
  status: AgentStatus;
  capabilities: string[];
  currentTask?: string;
  lastHeartbeat?: Date;
}

export type AgentRole = 'orchestrator' | 'executor' | 'reviewer' | 'specialist';
export type SpecialistType = 'architect' | 'tester' | 'docwriter' | 'security';
export type AgentStatus = 'idle' | 'busy' | 'error' | 'offline';

// Project-related types
export interface Project {
  id: string;
  name: string;
  description: string;
  tasks: Map<string, Task>;
  masterTask?: string;
  createdAt: Date;
  updatedAt: Date;
  bdSynced: boolean;
}

// Event types
export interface Event<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: Date;
  source: string;
}

// Error types
export interface FingerError extends Error {
  code: string;
  severity: 'warning' | 'error' | 'critical';
  retryable: boolean;
  context?: Record<string, unknown>;
}

export const ERROR_CODES = {
  BLOCK_NOT_FOUND: 'BLOCK_NOT_FOUND',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  TASK_BLOCKED: 'TASK_BLOCKED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BD_SYNC_ERROR: 'BD_SYNC_ERROR',
  NOT_INITIALIZED: 'NOT_INITIALIZED',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND'
} as const;

// Configuration types
export interface OrchestratorConfig {
  serverHost: string;
  serverPort: number;
  dbPath: string;
  retryConfig: RetryConfig;
  timeoutConfig: TimeoutConfig;
}

export interface RetryConfig {
  maxRetries: number;
  retryDelayMs: number;
  retryBackoff: 'fixed' | 'exponential';
  retryableErrors: string[];
}

export interface TimeoutConfig {
  task: number;
  heartbeat: number;
  agent: number;
  review: number;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  serverHost: 'localhost',
  serverPort: 8080,
  dbPath: './data/finger.db',
  retryConfig: {
    maxRetries: 3,
    retryDelayMs: 1000,
    retryBackoff: 'exponential',
    retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMIT']
  },
  timeoutConfig: {
    task: 30 * 60 * 1000,      // 30 min
    heartbeat: 60 * 1000,      // 1 min
    agent: 5 * 60 * 1000,      // 5 min
    review: 24 * 60 * 60 * 1000 // 24 hours
  }
};
