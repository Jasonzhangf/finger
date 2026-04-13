/**
 * Reasoning Types - 类型定义（中性命名，新文件）
 * 
 * 去掉 codex 命名，用 reasoning 代表模块意义。
 * 所有类型使用中性命名，不带有业务含义。
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ISessionManager } from '../../orchestration/session-types.js';
import type { ChatCodexDeveloperRole as DeveloperRole } from './developer-prompt-templates.js';

// ==================== 核心角色与配置 ====================

export type ReasoningRoleProfile = 'project' | 'system' | 'general';

export interface ReasoningToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ReasoningToolExecutionConfig {
  daemonUrl: string;
  agentId: string;
}

export interface ReasoningModuleConfig {
  id: string;
  name: string;
  version: string;
  timeoutMs: number;
  timeoutRetryCount: number;
  defaultRoleProfile?: ReasoningRoleProfile;
  binaryPath?: string;
  codingPromptPath?: string;
  developerPromptPaths?: Partial<Record<DeveloperRole, string>>;
  resolvePromptPaths?: () => {
    codingPromptPath?: string;
    developerPromptPaths?: Partial<Record<DeveloperRole, string>>;
  };
  resolveToolSpecifications?: (toolNames: string[]) => Promise<ReasoningToolSpec[]> | ReasoningToolSpec[];
  toolExecution?: ReasoningToolExecutionConfig;
  onLoopEvent?: (event: ReasoningLoopEvent) => void | Promise<void>;
  messageHub?: MessageHub;
  contextHistoryProvider?: (sessionId: string, limit: number) => Promise<Array<{
    id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }> | null>;
  digestProvider?: (
    sessionId: string,
    message: { id: string; role: string; content: string; timestamp: string },
    tags: string[],
    agentId?: string,
    mode?: string,
  ) => Promise<void>;
  sessionManager?: ISessionManager;
}

// ==================== 运行结果与事件 ====================

export interface ReasoningResult {
  reply: string;
  events: ReasoningKernelEvent[];
  usedBinaryPath: string;
  kernelMetadata?: Record<string, unknown>;
}

export interface ReasoningLoopEvent {
  sessionId: string;
  phase: 'turn_start' | 'kernel_event' | 'turn_complete' | 'turn_error';
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ReasoningKernelEvent {
  type: string;
  timestamp: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

// ==================== 内部追踪类型 ====================

export interface ReasoningToolTrace {
  seq?: number;
  callId?: string;
  tool: string;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface ReasoningRoundTrace {
  seq?: number;
  round: number;
  functionCallsCount?: number;
  reasoningCount?: number;
  historyItemsCount?: number;
  hasOutputText?: boolean;
  finishReason?: string;
  responseStatus?: string;
  responseIncompleteReason?: string;
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedTokensInContextWindow?: number;
  estimatedTokensCompactable?: number;
  contextUsagePercent?: number;
  maxInputTokens?: number;
  thresholdPercent?: number;
}

export interface ReasoningContextSnapshot {
  totalHistoryItems?: number;
  userItems?: number;
  assistantItems?: number;
  systemItems?: number;
  toolCallItems?: number;
  toolResultItems?: number;
  estimatedTokens?: number;
  maxTokens?: number;
}

// ==================== 运行上下文 ====================

export interface ReasoningContext {
  roleProfile?: ReasoningRoleProfile;
  sessionId?: string;
  promptOverridePath?: string;
  developerRole?: DeveloperRole;
  extraContextSlots?: Array<{ key: string; value: string }>;
  projectPath?: string;
  traceId?: string;
  bypassToolGate?: boolean;
  autoContextRebuild?: boolean;
  autoDigest?: boolean;
  digestMode?: string;
  metadata?: Record<string, unknown>;
}

// ==================== Runner 接口 ====================

export type ReasoningInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ReasoningRunner {
  runTurn(text: string, items?: ReasoningInputItem[], context?: ReasoningContext): Promise<ReasoningResult>;
  interrupt(sessionId: string): Promise<ReasoningInterruptResult | null>;
  getSessionState(sessionId: string): ReasoningSessionState | null;
}

export interface ReasoningTurnOptions {
  text: string;
  historyItems?: ReasoningInputItem[];
  context?: ReasoningContext;
}

// ==================== Session 与 Turn 管理 ====================

export interface ActiveReasoningTurn {
  submissionId: string;
  resolve: (result: ReasoningResult) => void;
  reject: (error: Error) => void;
  events: ReasoningKernelEvent[];
  startTime: number;
  stallTimeout?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  options: ReasoningTurnOptions;
  trace?: {
    rounds: ReasoningRoundTrace[];
    tools: ReasoningToolTrace[];
    contextBreakdown?: ReasoningContextSnapshot;
  };
  pendingTurnItems?: ReasoningInputItem[];
  pendingTurnText?: string;
}

export interface ReasoningSessionProcess {
  id: string;
  process: unknown;
  submissionIdPrefix: string;
  activeTurn: ActiveReasoningTurn | null;
  stallTimeout?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  lastActivityTime: number;
  disposed: boolean;
  context?: ReasoningContext;
}

export interface ReasoningSessionState {
  sessionId: string;
  activeTurn?: {
    startTime: number;
    eventsCount: number;
  };
  lastActivityTime: number;
  disposed: boolean;
}

export interface ReasoningInterruptResult {
  sessionId: string;
  interrupted: boolean;
  reason: string;
}

// ==================== Kernel 响应解析 ====================

export interface ReasoningKernelResponseItem {
  id?: string;
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  content?: Array<{ type: string; text?: string }>;
}

export interface ReasoningKernelResponse {
  id: string;
  status: string;
  incomplete_reason?: string;
  finish_reason?: string;
  output?: ReasoningKernelResponseItem[];
}

// ==================== Control Block ====================

export interface ReasoningControlBlock {
  stop?: boolean;
  ask?: string;
  reasoning?: { stop?: boolean };
  tags?: string[];
  learning?: {
    long_term_items?: string[];
    short_term_items?: string[];
    flow_patch?: Record<string, unknown>;
    user_profile_patch?: Record<string, unknown>;
  };
  agent_status?: {
    progress?: string;
    key_events?: string[];
    project_task_state?: Record<string, unknown>;
  };
}

// ==================== 事件解析 ====================

export interface ReasoningParsedEvent {
  type: 'round_start' | 'function_call' | 'function_call_output' | 'text_delta' | 'round_end' | 'error' | 'stall';
  round?: number;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  text?: string;
  finish_reason?: string;
  status?: string;
  incomplete_reason?: string;
  response_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_usage_percent?: number;
  max_input_tokens?: number;
  threshold_percent?: number;
  error?: string;
  response?: ReasoningKernelResponse;
}
