/**
 * API Types - Finger Daemon 接口类型定义
 */

// ========== FSM 状态类型（与后端 workflow-fsm.ts 一致） ==========

/**
 * 工作流状态（完整 FSM 状态）
 */
export type WorkflowFSMState =
  | 'idle'                     // 空闲
  | 'semantic_understanding'   // 语义理解中
  | 'routing_decision'         // 路由决策中
  | 'plan_loop'                // 任务规划循环
  | 'execution'                // 任务执行中
  | 'review'                   // 审查中
  | 'replan_evaluation'        // 重规划评估
  | 'wait_user_decision'       // 等待用户决策
  | 'paused'                   // 已暂停
  | 'completed'                // 已完成
  | 'failed';                  // 已失败

/**
 * 任务状态（完整 FSM 状态）
 */
export type TaskFSMState =
  | 'created'           // 已创建
  | 'ready'             // 就绪
  | 'dispatching'       // 派发中
  | 'dispatched'        // 已派发（收到 ACK）
  | 'dispatch_failed'   // 派发失败
  | 'running'           // 执行中
  | 'execution_failed'  // 执行失败
  | 'execution_succeeded' // 执行成功
  | 'reviewing'         // 审查中
  | 'done'              // 完成
  | 'rework_required'   // 需要返工
  | 'blocked';          // 阻塞

/**
 * Agent 状态（完整 FSM 状态）
 */
export type AgentFSMState =
  | 'idle'       // 空闲
  | 'reserved'   // 已预留
  | 'running'    // 执行中
  | 'error'      // 错误
  | 'released';  // 已释放

// ========== 向后兼容的简化状态类型 ==========

export type WorkflowStatus = 'planning' | 'executing' | 'completed' | 'failed' | 'partial' | 'paused';
export type TaskStatus = 'pending' | 'blocked' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'paused';
export type AgentRuntimeStatus = 'idle' | 'running' | 'error' | 'paused';

// ========== 状态映射工具 ==========

/**
 * FSM 状态 → 简化状态（用于 UI 显示）
 */
export function mapWorkflowFSMToStatus(fsmState: WorkflowFSMState): WorkflowStatus {
  switch (fsmState) {
    case 'idle':
    case 'semantic_understanding':
    case 'routing_decision':
    case 'plan_loop':
      return 'planning';
    case 'execution':
    case 'review':
    case 'replan_evaluation':
      return 'executing';
    case 'wait_user_decision':
      return 'paused';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'executing';
  }
}

/**
 * FSM 状态 → 简化状态（用于 UI 显示）
 */
export function mapTaskFSMToStatus(fsmState: TaskFSMState): TaskStatus {
  switch (fsmState) {
    case 'created':
    case 'ready':
      return 'ready';
    case 'dispatching':
    case 'dispatched':
      return 'in_progress';
    case 'dispatch_failed':
      return 'blocked';
    case 'running':
      return 'in_progress';
    case 'execution_failed':
      return 'failed';
    case 'execution_succeeded':
    case 'reviewing':
    case 'done':
      return 'completed';
    case 'rework_required':
      return 'blocked';
    case 'blocked':
      return 'blocked';
    default:
      return 'pending';
  }
}

/**
 * FSM 状态 → 简化状态（用于 UI 显示）
 */
export function mapAgentFSMToStatus(fsmState: AgentFSMState): AgentRuntimeStatus {
  switch (fsmState) {
    case 'idle':
    case 'released':
      return 'idle';
    case 'reserved':
    case 'running':
      return 'running';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

// ========== 状态掩码配置 ==========

/**
 * 状态掩码配置 - 控制哪些状态对用户可见
 */
export interface StateMaskConfig {
  // 工作流状态掩码
  workflowStates: {
    hide: WorkflowFSMState[];  // 隐藏的状态
    showAs: Partial<Record<WorkflowFSMState, WorkflowFSMState>>; // 映射显示（如将内部状态映射为用户友好的状态）
  };
  
  // 任务状态掩码
  taskStates: {
    hide: TaskFSMState[];
    showAs: Partial<Record<TaskFSMState, TaskFSMState>>;
  };
  
  // Agent 状态掩码
  agentStates: {
    hide: AgentFSMState[];
    showAs: Partial<Record<AgentFSMState, AgentFSMState>>;
  };
  
  // 是否显示详细状态（开发模式）
  showDetailedStates: boolean;
}

/**
 * 默认状态掩码配置
 */
export const DEFAULT_STATE_MASK: StateMaskConfig = {
  workflowStates: {
    hide: ['semantic_understanding', 'routing_decision'], // 隐藏内部处理状态
    showAs: {
      'plan_loop': 'plan_loop',
      'execution': 'execution',
      'review': 'review',
    },
  },
  taskStates: {
    hide: ['dispatching', 'dispatched', 'execution_succeeded'], // 隐藏中间状态
    showAs: {
      'running': 'running',
      'done': 'done',
    },
  },
  agentStates: {
    hide: ['reserved', 'released'],
    showAs: {
      'running': 'running',
      'idle': 'idle',
      'error': 'error',
    },
  },
  showDetailedStates: false, // 默认关闭详细模式
};

/**
 * 应用状态掩码
 */
export function applyStateMask<T extends string>(
  state: T,
  config: StateMaskConfig,
  type: 'workflow' | 'task' | 'agent'
): T | null {
  const maskConfig = config[`${type}States`] as { hide: string[]; showAs: Record<string, string> };
  
  // 检查是否隐藏
  if (maskConfig.hide.includes(state as string)) {
    return null;
  }
  
  // 检查是否需要映射
  const mapped = maskConfig.showAs[state as string];
  if (mapped) {
    return mapped as T;
  }
  
  return state;
}

export interface StateSnapshot {
  workflowId: string;
  sessionId: string;
  fsmState: WorkflowFSMState;
  simplifiedStatus: WorkflowStatus;
  tasks: Array<{
    id: string;
    fsmState: TaskFSMState;
    simplifiedStatus: TaskStatus;
    assignee?: string;
  }>;
  agents: Array<{
    id: string;
    fsmState: AgentFSMState;
    simplifiedStatus: AgentRuntimeStatus;
  }>;
  timestamp: string;
}

// ========== 原有类型定义 ==========

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
  sessionTier?: string;
  ownerAgentId?: string;
  rootSessionId?: string;
  parentSessionId?: string;
  sessionWorkspaceRoot?: string;
  lastMessageAt?: string;
  previewSummary?: string;
  previewMessages?: Array<{
    role: 'user' | 'assistant' | 'system' | 'orchestrator';
    timestamp: string;
    summary: string;
  }>;
}

export interface PickDirectoryResponse {
  path: string | null;
  canceled: boolean;
  error?: string;
}

// ========== Workflow Runtime Types ==========

export interface WorkflowInfo {
  id: string;
  sessionId: string;
  epicId?: string;
  status: WorkflowStatus;
  fsmState?: WorkflowFSMState; // 新增：完整 FSM 状态
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
  fsmState?: TaskFSMState; // 新增：完整 FSM 状态
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
  fsmState?: TaskFSMState;
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
  fsmState?: AgentFSMState; // 新增：完整 FSM 状态
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
  role?: 'executor' | 'reviewer' | 'orchestrator' | 'searcher';
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
  enabled?: boolean;
  capabilities?: string[];
  defaultQuota?: number;
  quotaPolicy?: {
    projectQuota?: number;
    workflowQuota?: Record<string, number>;
  };
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
  fsmState?: WorkflowFSMState; // 新增：完整 FSM 状态
  orchestratorPhase?: string; // 新增：编排器原始 phase（兼容 V2 FSM）
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
  wireApi?: string;
  envKey?: string;
  model?: string;
  apiKey?: string;
  defaultModel?: string;
  isActive?: boolean;
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
  type: string;
  payload?: unknown;
  timestamp: string;
  sessionId?: string;
  group?: string;
  agentId?: string;
  taskId?: string;
  clientId?: string;
  acquired?: boolean;
  alive?: boolean;
  state?: {
    sessionId: string;
    lockedBy: string | null;
    lockedAt: string | null;
    typing: boolean;
    lastHeartbeatAt?: string | null;
    expiresAt?: string | null;
  };
  error?: string;
}

export interface RuntimeEvent {
  id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  kind?: 'thought' | 'action' | 'observation' | 'status';
  toolName?: string;
  toolCategory?: '编辑' | '读取' | '写入' | '计划' | '搜索' | '网络搜索' | '其他';
  toolInput?: unknown;
  toolOutput?: unknown;
  toolStatus?: 'running' | 'success' | 'error';
  toolDurationMs?: number;
  planSteps?: RuntimePlanStep[];
  planExplanation?: string;
  planUpdatedAt?: string;
  images?: RuntimeImage[];
  files?: RuntimeFile[];
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimated?: boolean;
  };
  errorMessage?: string;
  fsmState?: WorkflowFSMState | TaskFSMState | AgentFSMState; // 新增：FSM 状态
}

export interface RuntimeImage {
  id: string;
  name: string;
  url: string;
  dataUrl?: string;
  mimeType?: string;
  size?: number;
}

export interface RuntimeFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  textContent?: string;
}

export type RuntimePlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface RuntimePlanStep {
  step: string;
  status: RuntimePlanStepStatus;
}

export interface UserRound {
  roundId: string;
  timestamp: string;
  summary: string;
  fullText: string;
  images?: RuntimeImage[];
  files?: RuntimeFile[];
}

export type ReviewStrictness = 'strict' | 'mainline';

export interface ReviewSettings {
  enabled: boolean;
  target: string;
  strictness: ReviewStrictness;
  maxTurns: number;
}

export interface UserInputPayload {
  text: string;
  images?: RuntimeImage[];
  files?: RuntimeFile[];
  review?: ReviewSettings;
  planModeEnabled?: boolean;
}

export interface WorkflowUpdatePayload {
  workflowId: string;
  status: WorkflowStatus;
  fsmState?: WorkflowFSMState; // 新增：完整 FSM 状态
  round?: number;
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
  fsmState?: AgentFSMState; // 新增：完整 FSM 状态
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
