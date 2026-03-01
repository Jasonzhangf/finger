import type {
  WorkflowExecutionState,
  WorkflowInfo,
  AgentExecutionDetail,
  TaskReport,
  RuntimeEvent,
  UserInputPayload,
  UserRound,
  ExecutionRound,
} from '../api/types.js';

export type KernelInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; image_url: string }
  | { type: 'local_image'; path: string };

export interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  taskId?: string;
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
    duration?: number;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
  stopReason?: string;
}

export interface SessionApiAttachment {
  id: string;
  name: string;
  type: 'image' | 'file' | 'code';
  url: string;
  size?: number;
}

export interface SessionApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  timestamp: string;
  type?:
    | 'text'
    | 'command'
    | 'plan_update'
    | 'task_update'
    | 'tool_call'
    | 'tool_result'
    | 'tool_error'
    | 'agent_step'
    | 'dispatch';
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
  attachments?: SessionApiAttachment[];
}

export interface RuntimeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

export interface AgentRunStatus {
  phase: 'idle' | 'running' | 'dispatching' | 'error';
  text: string;
  updatedAt: string;
}

export interface RuntimeOverview {
  reqTokens?: number;
  respTokens?: number;
  totalTokens?: number;
  tokenUpdatedAtLocal?: string;
  contextUsagePercent?: number;
  contextTokensInWindow?: number;
  contextMaxInputTokens?: number;
  contextThresholdPercent?: number;
  ledgerFocusMaxChars: number;
  lastLedgerInsertChars?: number;
  compactCount: number;
  updatedAt: string;
}

export interface RuntimeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

export interface ToolPanelOverview {
  availableTools: string[];
  exposedTools: string[];
}

export type DebugSnapshotStage =
  | 'request_build'
  | 'request_attempt'
  | 'request_ok'
  | 'request_error'
  | 'chat_codex_turn'
  | 'phase_transition'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error';

export interface DebugSnapshotItem {
  id: string;
  timestamp: string;
  sessionId: string;
  stage: DebugSnapshotStage;
  summary: string;
  requestId?: string;
  attempt?: number;
  phase?: string;
  payload?: unknown;
}

export interface OrchestratorRuntimeModeState {
  mode: string;
  fsmV2Implemented: boolean;
  runnerModuleId?: string;
  updatedAt: string;
}

export interface InputLockState {
  sessionId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  typing: boolean;
  lastHeartbeatAt?: string | null;
  expiresAt?: string | null;
}

export interface UseWorkflowExecutionReturn {
  workflow: WorkflowInfo | null;
  executionState: WorkflowExecutionState | null;
  runtimeEvents: RuntimeEvent[];
  userRounds: UserRound[];
  executionRounds: ExecutionRound[];
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  isLoading: boolean;
  error: string | null;
  startWorkflow: (userTask: string) => Promise<void>;
  pauseWorkflow: () => Promise<void>;
  resumeWorkflow: () => Promise<void>;
  interruptCurrentTurn: () => Promise<boolean>;
  sendUserInput: (input: UserInputPayload) => Promise<void>;
  editRuntimeEvent: (eventId: string, content: string) => Promise<boolean>;
  deleteRuntimeEvent: (eventId: string) => Promise<boolean>;
  agentRunStatus: AgentRunStatus;
  runtimeOverview: RuntimeOverview;
  toolPanelOverview: ToolPanelOverview;
  updateToolExposure: (tools: string[]) => Promise<boolean>;
  contextEditableEventIds: string[];
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReport | null;
  isConnected: boolean;
  inputLockState: InputLockState | null;
  clientId: string | null;
  acquireInputLock: () => Promise<boolean>;
  releaseInputLock: () => void;
  debugSnapshotsEnabled: boolean;
  setDebugSnapshotsEnabled: (enabled: boolean) => void;
  debugSnapshots: DebugSnapshotItem[];
  clearDebugSnapshots: () => void;
  orchestratorRuntimeMode: OrchestratorRuntimeModeState | null;
}

export type ToolCategoryLabel = '编辑' | '读取' | '写入' | '计划' | '搜索' | '网络搜索' | '其他';
export type AgentRunPhase = AgentRunStatus['phase'];
