/**
 * ChatCodex Types - 类型定义（从 chat-codex-module.ts 拆分）
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ISessionManager } from '../../orchestration/session-types.js';
import type { ChatCodexDeveloperRole } from './developer-prompt-templates.js';

export type ChatCodexRoleProfileId = 'project' | 'system' | 'general';

export interface ChatCodexToolSpecification {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ChatCodexToolExecutionConfig {
  daemonUrl: string;
  agentId: string;
}

export interface ChatCodexModuleConfig {
  id: string;
  name: string;
  version: string;
  timeoutMs: number;
  timeoutRetryCount: number;
  defaultRoleProfileId?: ChatCodexRoleProfileId;
  binaryPath?: string;
  codingPromptPath?: string;
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
  resolvePromptPaths?: () => {
    codingPromptPath?: string;
    developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
  };
  resolveToolSpecifications?: (toolNames: string[]) => Promise<ChatCodexToolSpecification[]> | ChatCodexToolSpecification[];
  toolExecution?: ChatCodexToolExecutionConfig;
  onLoopEvent?: (event: ChatCodexLoopEvent) => void | Promise<void>;
  messageHub?: MessageHub;
  /** Optional history provider. If provided, KernelAgentBase will use this for inference history. */
  contextHistoryProvider?: (sessionId: string, limit: number) => Promise<Array<{
    id?: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }> | null>;

  /** Optional digest provider for finish_reason=stop digest generation. */
  digestProvider?: (
    sessionId: string,
    message: { id: string; role: string; content: string; timestamp: string },
    tags: string[],
    agentId?: string,
    mode?: string,
  ) => Promise<void>;
  
  /** Optional session manager. If not provided, a default SessionManager will be created. */
  sessionManager?: ISessionManager;
}

export interface ChatCodexRunResult {
  reply: string;
  events: ChatCodexKernelEvent[];
  usedBinaryPath: string;
  kernelMetadata?: Record<string, unknown>;
}

export interface ChatCodexLoopEvent {
  sessionId: string;
  phase: 'turn_start' | 'kernel_event' | 'turn_complete' | 'turn_error';
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface KernelToolTraceItem {
  seq?: number;
  callId?: string;
  tool: string;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

export interface KernelRoundTraceItem {
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

export interface ContextBreakdownSnapshot {
  totalHistoryItems?: number;
  userItems?: number;
  assistantItems?: number;
  systemItems?: number;
  toolCallItems?: number;
  toolResultItems?: number;
  estimatedTokens?: number;
  maxTokens?: number;
}

export interface ChatCodexRunContext {
  roleProfileId?: ChatCodexRoleProfileId;
  sessionId?: string;
  /** Prompt override path; if specified, takes precedence over default prompt paths. */
  promptOverridePath?: string;
  /** Developer role for this turn; if specified, uses the role-specific prompt. */
  developerRole?: ChatCodexDeveloperRole;
  /** Extra context slots to inject into the kernel prompt. */
  extraContextSlots?: Array<{ key: string; value: string }>;
  /** Project path for session binding. */
  projectPath?: string;
  /** Trace ID for logging. */
  traceId?: string;
  /** If true, skip tool gate and allow model to use all tools. */
  bypassToolGate?: boolean;
  /** If true, kernel will auto-call context_history.rebuild after this turn completes. */
  autoContextRebuild?: boolean;
  /** If true, kernel will auto-call digest after this turn completes (finish_reason=stop). */
  autoDigest?: boolean;
  /** Optional mode for digest generation. */
  digestMode?: string;
}

export type KernelInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export interface ChatCodexRunner {
  runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult>;
  interrupt(sessionId: string): Promise<ChatCodexRunnerInterruptResult | null>;
  getSessionState(sessionId: string): ChatCodexRunnerSessionState | null;
}

export interface KernelUserTurnOptions {
  text: string;
  historyItems?: KernelInputItem[];
  context?: ChatCodexRunContext;
}

export interface ChatCodexKernelEvent {
  type: string;
  timestamp: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface ActiveKernelTurn {
  submissionId: string;
  resolve: (result: ChatCodexRunResult) => void;
  reject: (error: Error) => void;
  events: ChatCodexKernelEvent[];
  startTime: number;
  stallTimeout?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  options: KernelUserTurnOptions;
  trace?: {
    rounds: KernelRoundTraceItem[];
    tools: KernelToolTraceItem[];
    contextBreakdown?: ContextBreakdownSnapshot;
  };
  pendingTurnItems?: KernelInputItem[];
  pendingTurnText?: string;
}

export interface KernelSessionProcess {
  id: string;
  process: unknown;
  submissionIdPrefix: string;
  activeTurn: ActiveKernelTurn | null;
  stallTimeout?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  lastActivityTime: number;
  disposed: boolean;
  context?: ChatCodexRunContext;
}

export interface ChatCodexRunnerSessionState {
  sessionId: string;
  activeTurn?: {
    startTime: number;
    eventsCount: number;
  };
  lastActivityTime: number;
  disposed: boolean;
}

export interface ChatCodexRunnerInterruptResult {
  sessionId: string;
  interrupted: boolean;
  reason: string;
}

// Internal response parsing types (not exported)
export interface ChatCodexResponse {
  id: string;
  status: string;
  incomplete_reason?: string;
  finish_reason?: string;
  output?: Array<{
    id?: string;
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    content?: Array<{ type: string; text?: string }>;
  }>;
}

export interface FingerControlBlock {
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

export interface KernelParsedEvent {
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
  response?: ChatCodexResponse;
}
