import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { createInterface } from 'readline';
import type { OutputModule } from '../../orchestration/module-registry.js';
import type { ISessionManager } from '../../orchestration/session-types.js';
import { SessionManager } from '../../orchestration/session-manager.js';
import { KernelAgentBase, type KernelAgentRunner, type KernelRunContext } from '../base/kernel-agent-base.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { resolveCodingCliSystemPrompt } from './coding-cli-system-prompt.js';
import {
  resolveDeveloperPromptTemplate,
  type ChatCodexDeveloperRole,
} from './developer-prompt-templates.js';
import { resolveResponsesOutputSchema } from './response-output-schemas.js';
import {
  BASE_AGENT_ROLE_CONFIG,
  resolveBaseAgentRole,
} from './agent-role-config.js';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../../core/finger-paths.js';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';
import { getFingerAppVersion } from '../../core/app-version.js';
import { getContextWindow, loadAIProviders } from '../../core/user-settings.js';
import type { MailboxSnapshot } from '../../runtime/mailbox-snapshot.js';
import { hasNewUnreadSinceLastNotified, getNewUnreadEntries } from '../../runtime/mailbox-snapshot.js';
import { formatSkillsAsPromptScopedSync } from '../../skills/skill-prompt-injector.js';
import { logger } from '../../core/logger.js';
import { estimateTokensWithTiktoken } from '../../utils/tiktoken-estimator.js';
import {
  evaluateControlHooks,
  parseControlBlockFromReply,
  resolveControlBlockPolicy,
  shouldHoldStopByControlBlock,
} from '../../common/control-block.js';
import {
  AUTONOMOUS_WORK_SECTION,
  FUNCTION_RESULT_CLEARING_SECTION,
  getAgentDefinition,
  getOutputStyleSection,
  type OutputStyle,
} from '../prompts/agent-definitions.js';
import {
  filterSections,
  type GuardedSection,
} from '../prompts/conditional-injector.js';
import { augmentToolSpecificationsWithCompatAliases } from '../../runtime/tool-compat-aliases.js';
import {
  executeContextLedgerMemory,
  resolveLedgerPath,
} from '../../runtime/context-ledger-memory.js';

const DEFAULT_KERNEL_TIMEOUT_MS = 600_000;
const DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT = 2;

// NOTE:
// 180s stall timeout is too aggressive when context is large (50k+ tokens) or provider
// has high queue latency. It caused false-positive "stalled" retries while the upstream
// request was still in progress, which then kept new inputs in pending queue forever.
// Align stall timeout with hard timeout by default to avoid premature interruption.
const DEFAULT_KERNEL_STALL_TIMEOUT_MS = 600_000;
const ACTIVE_TURN_STALE_GRACE_MS = 15_000;
const FLOW_PROMPT_MAX_CHARS = 10_000;
const USER_PROFILE_PROMPT_MAX_CHARS = 8_000;
const AGENTS_PROMPT_MAX_FILES = 4;
const AGENTS_PROMPT_MAX_CHARS_PER_FILE = 4_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;
const chatCodexLog = logger.module('ChatCodexModule');
export const CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const CHAT_CODEX_SEARCHER_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS = CHAT_CODEX_SEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODER_ALLOWED_TOOLS = CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS;
export const CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS = CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS;
export const CHAT_CODEX_PROJECT_ALLOWED_TOOLS = CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS;
export const CHAT_CODEX_SYSTEM_ALLOWED_TOOLS = [...BASE_AGENT_ROLE_CONFIG.system.allowedTools];

type ChatCodexRoleProfileId = 'project' | 'system' | 'general';

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

interface KernelToolTraceItem {
  seq?: number;
  callId?: string;
  tool: string;
  status: 'ok' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string;
  durationMs?: number;
}

interface KernelRoundTraceItem {
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

interface ContextBreakdownSnapshot {
  historyContextTokens?: number;
  historyCurrentTokens?: number;
  historyTotalTokens?: number;
  historyContextMessages?: number;
  historyCurrentMessages?: number;
  systemPromptTokens?: number;
  developerPromptTokens?: number;
  userInstructionsTokens?: number;
  environmentContextTokens?: number;
  turnContextTokens?: number;
  skillsTokens?: number;
  mailboxTokens?: number;
  projectTokens?: number;
  flowTokens?: number;
  contextSlotsTokens?: number;
  inputTextTokens?: number;
  inputMediaTokens?: number;
  inputMediaCount?: number;
  inputTotalTokens?: number;
  toolsSchemaTokens?: number;
  toolExecutionTokens?: number;
  contextLedgerConfigTokens?: number;
  responsesConfigTokens?: number;
  totalKnownTokens?: number;
  source?: string;
}

export interface ChatCodexRunContext {
  sessionId?: string;
  systemPrompt?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  metadata?: Record<string, unknown>;
  prebuiltOptions?: Record<string, unknown>;
  mailboxSnapshot?: MailboxSnapshot;
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
  tools?: ChatCodexToolSpecification[];
  toolExecution?: ChatCodexToolExecutionConfig;
  onKernelEvent?: (event: ChatCodexKernelEvent) => void;
}

export type KernelInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; image_url: string }
  | { type: 'local_image'; path: string };

export interface ChatCodexRunner {
  runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult>;
}

interface KernelUserTurnOptions {
  system_prompt?: string;
  session_id?: string;
  mode?: string;
  history_items?: Array<Record<string, unknown>>;
  developer_instructions?: string;
  user_instructions?: string;
  environment_context?: string;
  turn_context?: {
    cwd?: string;
    approval?: string;
    sandbox?: string;
    model?: string;
  };
  context_window?: {
    max_input_tokens?: number;
    baseline_tokens?: number;
    auto_compact_threshold_ratio?: number;
  };
  compact?: {
    manual?: boolean;
    preserve_user_messages?: boolean;
    summary_hint?: string;
  };
  fork_user_message_index?: number;
  context_ledger?: {
    enabled: boolean;
    root_dir?: string;
    agent_id?: string;
    role?: string;
    mode?: string;
    can_read_all?: boolean;
    readable_agents?: string[];
    focus_enabled?: boolean;
    focus_max_chars?: number;
  };
  responses?: {
    reasoning?: {
      enabled?: boolean;
      effort?: string;
      summary?: string;
      include_encrypted_content?: boolean;
    };
    text?: {
      enabled?: boolean;
      verbosity?: string;
      output_schema?: Record<string, unknown>;
    };
    include?: string[];
    store?: boolean;
    parallel_tool_calls?: boolean;
  };
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  tool_execution?: {
    daemon_url: string;
    agent_id: string;
    session_id?: string;
  };
}

export interface ChatCodexKernelEvent {
  id: string;
  msg: {
    type: string;
    last_agent_message?: string;
    message?: string;
    metadata_json?: string;
    call_id?: string;
    tool_name?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    duration_ms?: number;
    round?: number;
    function_calls_count?: number;
    reasoning_count?: number;
    history_items_count?: number;
    has_output_text?: boolean;
    seq?: number;
    finish_reason?: string;
    response_status?: string;
    response_incomplete_reason?: string;
    response_id?: string;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    estimated_tokens_in_context_window?: number;
    estimated_tokens_compactable?: number;
    context_usage_percent?: number;
    max_input_tokens?: number;
    threshold_percent?: number;
    model_context_window?: number;
  };
}

interface ActiveKernelTurn {
  id: string;
  startedAtMs: number;
  lastKernelEventAtMs: number;
  pendingInputQueued: boolean;
  pendingTurnId?: string;
  resolve: (value: ChatCodexRunResult) => void;
  reject: (reason?: unknown) => void;
  events: ChatCodexKernelEvent[];
  replyText?: string;
  kernelMetadata?: Record<string, unknown>;
  timeout: NodeJS.Timeout;
  stallTimeout: NodeJS.Timeout;
  settled: boolean;
  seenSessionConfigured: boolean;
  onKernelEvent?: (event: ChatCodexKernelEvent) => void;
}

interface KernelSessionProcess {
  key: string;
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  resolvedBinaryPath: string;
  providerId: string;
  stderrBuffer: string;
  submissionSeq: number;
  activeTurn: ActiveKernelTurn | null;
  /** Exit code if child process has exited, null otherwise */
  exitCode: number | null;
  /** Exit signal if child process was killed, null otherwise */
  exitSignal: NodeJS.Signals | null;
}

export interface ChatCodexRunnerSessionState {
  sessionKey: string;
  sessionId: string;
  providerId: string;
  hasActiveTurn: boolean;
  activeTurnId?: string;
}

export interface ChatCodexRunnerInterruptResult {
  sessionKey: string;
  sessionId: string;
  providerId: string;
  hadActiveTurn: boolean;
  interrupted: boolean;
  activeTurnId?: string;
}

interface ChatCodexResponse {
  success: boolean;
  response?: string;
  error?: string;
  module: string;
  provider: string;
  sessionId: string;
  messageId?: string;
  latencyMs: number;
  metadata?: {
    roleProfile?: string;
    tools?: string[];
    binaryPath: string;
    eventCount: number;
    [key: string]: unknown;
  };
}

const DEFAULT_CONFIG: ChatCodexModuleConfig = {
  id: 'chat-codex',
  name: 'Chat Codex Bridge',
  version: getFingerAppVersion(),
  timeoutMs: DEFAULT_KERNEL_TIMEOUT_MS,
  timeoutRetryCount: DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT,
};

const ROUTER_SYSTEM_PROMPT = [
  '你是 finger 的路由代理。',
  '目标：识别输入意图并路由到最合适的模块或 agent。',
  '要求：',
  '1. 优先准确路由，无法判定时返回澄清问题。',
  '2. 输出结构化结论，包含目标、原因、备选目标。',
  '3. 不执行重工具任务，仅负责分流与策略决策。',
].join('\n');

function safeNotifyLoopEvent(
  callback: ChatCodexModuleConfig['onLoopEvent'],
  event: ChatCodexLoopEvent,
): void {
  if (!callback) return;
  void Promise.resolve(callback(event)).catch((error) => {
    chatCodexLog.warn('Loop event callback failed', {
      sessionId: event.sessionId,
      phase: event.phase,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('timed out') || normalized.includes('timeout');
}

export function isRetryableRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('daily_cost_limit_exceeded')) return false;
  if (normalized.includes('insufficient_quota')) return false;
  if (normalized.includes('unauthorized')) return false;
  if (normalized.includes('forbidden')) return false;
  if (normalized.includes(' 401') || normalized.includes('_401') || normalized.includes('error code: 401')) return false;
  if (normalized.includes(' 402') || normalized.includes('_402') || normalized.includes('error code: 402')) return false;
  if (normalized.includes(' 403') || normalized.includes('_403') || normalized.includes('error code: 403')) return false;
  const noEndpoint404 = (
    normalized.includes('no endpoints found for')
    && (
      normalized.includes('status: 404')
      || normalized.includes('http 404')
      || normalized.includes('code":"http_404')
      || normalized.includes("code:'http_404")
    )
  );

  return isTimeoutError(error)
    || noEndpoint404
    || normalized.includes('stalled without kernel events')
    || normalized.includes('stale active turn evicted')
    || normalized.includes('active turn superseded')
    || normalized.includes('kernel stdin stream error')
    || normalized.includes('write epipe')
    || normalized.includes('did not contain a completed response payload')
    || normalized.includes('completed response payload')
    || normalized.includes('stream ended before completed response')
    || normalized.includes('response stream ended prematurely')
    || normalized.includes('fetch failed')
    || normalized.includes('gateway')
    || normalized.includes('result timeout')
    || normalized.includes('ack timeout')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up')
    || normalized.includes(' 408')
    || normalized.includes('_408')
    || normalized.includes(' 409')
    || normalized.includes('_409')
    || normalized.includes(' 425')
    || normalized.includes('_425')
    || normalized.includes(' 429')
    || normalized.includes('_429')
    || normalized.includes(' 500')    || normalized.includes('_500')
    || normalized.includes(' 502')    || normalized.includes('_502')
    || normalized.includes(' 503')    || normalized.includes('_503')
    || normalized.includes(' 504')    || normalized.includes('_504')
    || normalized.includes('error code: 502')
    || normalized.includes('error code: 500')
    || normalized.includes('error code: 503')
    || normalized.includes('error code: 504');
}

function retryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  const clampedAttempt = Math.max(1, attempt);
  return Math.min(30_000, Math.floor(750 * Math.pow(2, clampedAttempt - 1)));
}

export class ProcessChatCodexRunner implements ChatCodexRunner {
  private readonly timeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly binaryPath?: string;
  private readonly toolExecution?: ChatCodexToolExecutionConfig;
  private readonly developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
  private readonly sessions = new Map<string, KernelSessionProcess>();

  constructor(options: Pick<ChatCodexModuleConfig, 'timeoutMs' | 'binaryPath' | 'toolExecution' | 'developerPromptPaths'> & {
    stallTimeoutMs?: number;
  }) {
    this.timeoutMs = options.timeoutMs;
    this.stallTimeoutMs = Number.isFinite(options.stallTimeoutMs)
      ? Math.max(30_000, Math.floor(options.stallTimeoutMs as number))
      : DEFAULT_KERNEL_STALL_TIMEOUT_MS;
    this.binaryPath = options.binaryPath;
    this.toolExecution = options.toolExecution;
    this.developerPromptPaths = options.developerPromptPaths;
  }

  private estimateSubmissionPayloadSize(
    items: KernelInputItem[],
    options: KernelUserTurnOptions | undefined,
  ): number {
    const sampleSubmission = {
      id: 'sample',
      op: { type: 'user_turn', items, ...(options ? { options } : {}) },
    };
    return JSON.stringify(sampleSubmission).length;
  }

  private truncateHistoryItemsForPayloadLimit(
    options: KernelUserTurnOptions | undefined,
    maxPayloadChars: number,
  ): KernelUserTurnOptions | undefined {
    if (!options || !Array.isArray(options.history_items) || options.history_items.length <= 1) {
      return options;
    }
    let truncatedOptions = { ...options, history_items: [...options.history_items] };
    while (truncatedOptions.history_items.length > 1) {
      const estimatedSize = this.estimateSubmissionPayloadSize([], truncatedOptions);
      if (estimatedSize <= maxPayloadChars) {
        break;
      }
      truncatedOptions.history_items.shift();
    }
    return truncatedOptions;
  }

  async runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
    const resolvedPath = resolveKernelBinaryPath(this.binaryPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`kernel bridge binary not found: ${resolvedPath}`);
    }

    const providerId = resolveRunnerProviderId(context);
    if (!providerId || providerId.trim().length === 0) {
      throw new Error('AI provider is not configured. Please set aiProviders.default in ~/.finger/config/user-settings.json');
    }
    const sessionId = normalizeRunnerSessionId(context?.sessionId);
    let session = this.ensureSession(sessionId, resolvedPath, providerId);
    const normalizedItems = normalizeKernelInputItems(items, text);
    const options = isRecord(context?.prebuiltOptions)
      ? hydratePrebuiltKernelUserTurnOptions(
          context.prebuiltOptions as KernelUserTurnOptions,
          context,
          this.toolExecution,
          context?.developerPromptPaths ?? this.developerPromptPaths,
        )
      : buildKernelUserTurnOptions(
          context,
          this.toolExecution,
          context?.developerPromptPaths ?? this.developerPromptPaths,
        );
    let mustRefreshSession = false;
    if (session.activeTurn) {
      const childUnavailable = session.child.killed
        || session.child.exitCode !== null
        || session.child.stdin.destroyed
        || !session.child.stdin.writable;
      if (childUnavailable) {
        chatCodexLog.warn('Active turn session process is not writable/alive; evicting stale turn immediately', {
          sessionKey: session.key,
          activeTurnId: session.activeTurn.id,
          killed: session.child.killed,
          exitCode: session.child.exitCode,
          stdinDestroyed: session.child.stdin.destroyed,
          stdinWritable: session.child.stdin.writable,
        });
        this.rejectActiveTurn(
          session,
          new Error('chat-codex active turn session is unavailable (process/stdin stale)'),
          true,
        );
        mustRefreshSession = true;
      }
    }
    if (session.activeTurn) {
      const staleCheck = this.inspectActiveTurnStaleness(session.activeTurn);
      if (staleCheck.stale) {
        chatCodexLog.warn('Detected stale active turn while new input arrived; evicting stale turn', {
          sessionKey: session.key,
          activeTurnId: session.activeTurn.id,
          idleMs: staleCheck.idleMs,
          ageMs: staleCheck.ageMs,
          stallTimeoutMs: this.stallTimeoutMs,
          timeoutMs: this.timeoutMs,
        });
        this.rejectActiveTurn(
          session,
          new Error(`chat-codex stale active turn evicted (idle=${staleCheck.idleMs}ms, age=${staleCheck.ageMs}ms)`),
          true,
        );
        mustRefreshSession = true;
      }
    }
    if (session.activeTurn) {
      if (session.activeTurn.pendingInputQueued) {
        // Source-level anti-stall: if another input arrives while one pending input is
        // already queued behind the same active turn, that turn is likely not draining.
        // Supersede immediately instead of waiting for timeout.
        const supersededTurnId = session.activeTurn.id;
        chatCodexLog.warn('Active turn superseded by newer input after pending queue already existed', {
          sessionKey: session.key,
          activeTurnId: supersededTurnId,
          pendingTurnId: session.activeTurn.pendingTurnId,
        });
        this.rejectActiveTurn(
          session,
          new Error('chat-codex active turn superseded by newer user input'),
          true,
        );
        mustRefreshSession = true;
      }
    }
    if (mustRefreshSession) {
      session = this.ensureSession(sessionId, resolvedPath, providerId);
    }
    if (session.activeTurn) {
      const pendingTurnId = this.nextSubmissionId(session, 'pending');
      const maxPayloadChars = Math.floor(getContextWindow() * 0.9);
      let protectedOptions = options;
      const estimatedSize = this.estimateSubmissionPayloadSize(normalizedItems, options);
      if (estimatedSize > maxPayloadChars) {
        chatCodexLog.warn('Submission payload exceeds limit, truncating history', {
          estimatedSize,
          maxPayloadChars,
          historyItemsCount: Array.isArray(options?.history_items) ? options.history_items.length : 0,
        });
        protectedOptions = this.truncateHistoryItemsForPayloadLimit(options, maxPayloadChars);
        const newSize = this.estimateSubmissionPayloadSize(normalizedItems, protectedOptions);
        chatCodexLog.info('History truncated to fit payload limit', {
          newHistoryItemsCount: Array.isArray(protectedOptions?.history_items) ? protectedOptions.history_items.length : 0,
          newEstimatedSize: newSize,
        });
      }
      this.sendUserTurnSubmission(session, pendingTurnId, normalizedItems, protectedOptions);
      session.activeTurn.pendingInputQueued = true;
      session.activeTurn.pendingTurnId = pendingTurnId;
      return {
        reply: '已加入当前执行队列，等待本轮合并处理。',
        events: [
          {
            id: pendingTurnId,
            msg: {
              type: 'pending_input_queued',
              message: 'pending input queued to active turn',
            },
          },
        ],
        usedBinaryPath: resolvedPath,
        kernelMetadata: {
          pendingInputAccepted: true,
          activeTurnId: session.activeTurn.id,
          pendingTurnId,
        },
      };
    }

    const turnId = this.nextSubmissionId(session, 'turn');
    return new Promise<ChatCodexRunResult>((resolve, reject) => {
      const timeout = this.createHardTimeout(session);
      const stallTimeout = this.createStallTimeout(session);
      const now = Date.now();

      session.activeTurn = {
        id: turnId,
        startedAtMs: now,
        lastKernelEventAtMs: now,
        pendingInputQueued: false,
        resolve,
        reject,
        events: [],
        timeout,
        stallTimeout,
        settled: false,
        seenSessionConfigured: false,
        onKernelEvent: context?.onKernelEvent,
      };

      const maxPayloadChars = Math.floor(getContextWindow() * 0.9);
      let protectedOptions = options;
      const estimatedSize = this.estimateSubmissionPayloadSize(normalizedItems, options);
      if (estimatedSize > maxPayloadChars) {
        chatCodexLog.warn('Submission payload exceeds limit, truncating history', {
          estimatedSize,
          maxPayloadChars,
          historyItemsCount: Array.isArray(options?.history_items) ? options.history_items.length : 0,
        });
        protectedOptions = this.truncateHistoryItemsForPayloadLimit(options, maxPayloadChars);
        const newSize = this.estimateSubmissionPayloadSize(normalizedItems, protectedOptions);
        chatCodexLog.info('History truncated to fit payload limit', {
          newHistoryItemsCount: Array.isArray(protectedOptions?.history_items) ? protectedOptions.history_items.length : 0,
          newEstimatedSize: newSize,
        });
      }
      try {
        this.sendUserTurnSubmission(session, turnId, normalizedItems, protectedOptions);
      } catch (sendError) {
        // EPIPE race: child exited between Promise setup and stdin write
        // Reject the Promise immediately so caller can retry
        chatCodexLog.error('sendUserTurnSubmission failed during Promise setup', sendError instanceof Error ? sendError : undefined, {
          sessionKey: session.key,
          turnId,
          error: sendError instanceof Error ? sendError.message : String(sendError),
        });
        reject(sendError);
        return;
      }
    });
  }

  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
    const states: ChatCodexRunnerSessionState[] = [];
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (normalizedSessionId.length > 0 && session.sessionId !== normalizedSessionId) continue;
      if (normalizedProviderId.length > 0 && session.providerId !== normalizedProviderId) continue;
      states.push({
        sessionKey,
        sessionId: session.sessionId,
        providerId: session.providerId,
        hasActiveTurn: session.activeTurn !== null,
        ...(session.activeTurn?.id ? { activeTurnId: session.activeTurn.id } : {}),
      });
    }
    return states;
  }

  interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[] {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId.length === 0) return [];
    const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
    const results: ChatCodexRunnerInterruptResult[] = [];
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (session.sessionId !== normalizedSessionId) continue;
      if (normalizedProviderId.length > 0 && session.providerId !== normalizedProviderId) continue;
      const hadActiveTurn = session.activeTurn !== null;
      const activeTurnId = session.activeTurn?.id;
      if (hadActiveTurn) {
        this.rejectActiveTurn(session, new Error('chat-codex turn interrupted by user'), true);
      } else {
        this.disposeSession(session);
      }
      results.push({
        sessionKey,
        sessionId: session.sessionId,
        providerId: session.providerId,
        hadActiveTurn,
        interrupted: hadActiveTurn,
        ...(activeTurnId ? { activeTurnId } : {}),
      });
    }
    return results;
  }

 private ensureSession(sessionId: string, resolvedBinaryPath: string, providerId: string): KernelSessionProcess {
   const runtimeKey = resolveRunnerRuntimeKey(sessionId);
   let existing = this.sessions.get(runtimeKey);

   // Check if child process is orphan (PPID=1 means daemon respawned, parent died)
   // Orphan processes have stdin closed and will cause EPIPE
   if (existing && existing.child.pid && !existing.child.killed) {
     try {
       // Check if stdin is writable - orphan processes have stdin destroyed
       if (!existing.child.stdin.writable || existing.child.stdin.destroyed) {
         chatCodexLog.warn('Kernel stdin destroyed (orphan/zombie process), will dispose and respawn', {
           sessionKey: runtimeKey,
           childPid: existing.child.pid,
           stdinWritable: existing.child.stdin.writable,
           stdinDestroyed: existing.child.stdin.destroyed,
         });
         this.disposeSession(existing);
         this.sessions.delete(runtimeKey);
         existing = undefined;
       }
       // Also check if process has exited (exitCode set by exit handler)
       // This catches processes that exited but stdin state hasn't updated yet
       if (existing && existing.exitCode !== null) {
         chatCodexLog.warn('Kernel process already exited (exitCode set), will dispose and respawn', {
           sessionKey: runtimeKey,
           childPid: existing.child.pid,
           exitCode: existing.exitCode,
           exitSignal: existing.exitSignal,
         });
         this.disposeSession(existing);
         this.sessions.delete(runtimeKey);
         existing = undefined;
       }
     } catch (checkError) {
      chatCodexLog.warn('Error checking kernel stdin state, will dispose and respawn', {
        sessionKey: runtimeKey,
        error: checkError instanceof Error ? checkError.message : String(checkError),
      });
      if (existing) {
        this.disposeSession(existing);
      }
      this.sessions.delete(runtimeKey);
      existing = undefined;
    }
   }

   if (
     existing
     && !existing.child.killed
     && existing.resolvedBinaryPath === resolvedBinaryPath
     && existing.providerId === providerId
   ) {
     return existing;
   }

    if (existing) {
      chatCodexLog.info('Refreshing kernel runtime for session due to runtime config change', {
        sessionId: existing.sessionId,
        previousProviderId: existing.providerId,
        nextProviderId: providerId,
        previousBinaryPath: existing.resolvedBinaryPath,
        nextBinaryPath: resolvedBinaryPath,
      });
      this.disposeSession(existing);
    }

    const spawnEnv = {
      ...process.env,
      FINGER_KERNEL_PROVIDER: providerId,
      FINGER_CONFIG_PATH: FINGER_PATHS.config.file.main,
    };
    const child = spawn(resolvedBinaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    }) as ChildProcessWithoutNullStreams;

    const session: KernelSessionProcess = {
      key: runtimeKey,
      sessionId,
      child,
      resolvedBinaryPath,
      providerId,
      stderrBuffer: '',
      submissionSeq: 0,
      activeTurn: null,
      exitCode: null,
      exitSignal: null,
    };
    this.sessions.set(runtimeKey, session);
    this.bindSessionEvents(session);
    return session;
  }

  private bindSessionEvents(session: KernelSessionProcess): void {
    const stdoutLines = createInterface({ input: session.child.stdout });
    stdoutLines.on('line', (line: string) => {
      this.handleKernelStdoutLine(session, line);
    });

    session.child.stderr.on('data', (chunk: Buffer | string) => {
      session.stderrBuffer += chunk.toString();
    });

    session.child.stdin.on('error', (error: Error) => {
      chatCodexLog.warn('Kernel stdin stream error', {
        sessionKey: session.key,
        error: error.message,
      });
      this.rejectActiveTurn(
        session,
        new Error(`chat-codex kernel stdin stream error: ${error.message}`),
        true,
      );
      this.sessions.delete(session.key);
    });

    session.child.on('error', (error: Error) => {
      this.rejectActiveTurn(session, error, true);
      this.sessions.delete(session.key);
    });

    session.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Mark session as exited BEFORE rejecting turn to prevent sendSubmission race
      session.exitCode = code;
      session.exitSignal = signal;
      const status = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
      const stderrMessage = session.stderrBuffer.trim();
      const detail = stderrMessage.length > 0 ? `; stderr: ${stderrMessage}` : '';
      this.rejectActiveTurn(
        session,
        new Error(`chat-codex process exited with ${status}${detail}`),
        false,
      );
      this.sessions.delete(session.key);
    });
  }

  private handleKernelStdoutLine(session: KernelSessionProcess, line: string): void {
    const parsed = parseKernelEvent(line);
    if (!parsed) return;

    const activeTurn = session.activeTurn;
    if (!activeTurn) return;
    activeTurn.lastKernelEventAtMs = Date.now();
    this.resetHardTimeout(session);
    this.resetStallTimeout(session);

    if (parsed.msg.type === 'session_configured') {
      if (!activeTurn.seenSessionConfigured) {
        activeTurn.seenSessionConfigured = true;
        activeTurn.events.push(parsed);
        this.notifyKernelEvent(activeTurn, parsed);
      }
      return;
    }

    if (parsed.id !== activeTurn.id) return;

    activeTurn.events.push(parsed);
    this.notifyKernelEvent(activeTurn, parsed);
    if (parsed.msg.type === 'error') {
      const errorMessage = parsed.msg.message ?? 'chat-codex kernel error';
      this.rejectActiveTurn(session, new Error(errorMessage), true);
      return;
    }

    if (parsed.msg.type !== 'task_complete') return;

    if (parsed.msg.last_agent_message && parsed.msg.last_agent_message.trim().length > 0) {
      activeTurn.replyText = parsed.msg.last_agent_message;
    }
    if (parsed.msg.metadata_json && parsed.msg.metadata_json.trim().length > 0) {
      activeTurn.kernelMetadata = parseKernelMetadata(parsed.msg.metadata_json);
    }

    const finalReply = activeTurn.replyText;
    if (!finalReply || finalReply.trim().length === 0) {
      this.rejectActiveTurn(session, new Error('chat-codex got empty model reply'), true);
      return;
    }

    this.resolveActiveTurn(session, {
      reply: finalReply,
      events: activeTurn.events,
      usedBinaryPath: session.resolvedBinaryPath,
      ...(activeTurn.kernelMetadata ? { kernelMetadata: activeTurn.kernelMetadata } : {}),
    });
  }

  private notifyKernelEvent(activeTurn: ActiveKernelTurn, event: ChatCodexKernelEvent): void {
    if (!activeTurn.onKernelEvent) return;
    try {
      activeTurn.onKernelEvent(event);
    } catch (error) {
      chatCodexLog.warn('Kernel event callback failed', {
        turnId: activeTurn.id,
        eventType: event.msg.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveActiveTurn(session: KernelSessionProcess, result: ChatCodexRunResult): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    activeTurn.settled = true;
    clearTimeout(activeTurn.timeout);
    clearTimeout(activeTurn.stallTimeout);
    session.activeTurn = null;
    activeTurn.resolve(result);
  }

  private rejectActiveTurn(
    session: KernelSessionProcess,
    error: Error,
    terminateSession: boolean,
  ): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn || activeTurn.settled) {
      if (terminateSession) {
        this.disposeSession(session);
      }
      return;
    }
    activeTurn.settled = true;
    clearTimeout(activeTurn.timeout);
    clearTimeout(activeTurn.stallTimeout);
    session.activeTurn = null;
    activeTurn.reject(error);
    if (terminateSession) {
      this.disposeSession(session);
    }
  }

  private createStallTimeout(session: KernelSessionProcess): NodeJS.Timeout {
    return setTimeout(() => {
      this.rejectActiveTurn(
        session,
        new Error(`chat-codex stalled without kernel events for ${this.stallTimeoutMs}ms`),
        true,
      );
    }, this.stallTimeoutMs);
  }

  private createHardTimeout(session: KernelSessionProcess): NodeJS.Timeout {
    return setTimeout(() => {
      this.rejectActiveTurn(
        session,
        new Error(`chat-codex timed out after ${this.timeoutMs}ms`),
        true,
      );
    }, this.timeoutMs);
  }

  private resetHardTimeout(session: KernelSessionProcess): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    clearTimeout(activeTurn.timeout);
    activeTurn.timeout = this.createHardTimeout(session);
  }

  private resetStallTimeout(session: KernelSessionProcess): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    clearTimeout(activeTurn.stallTimeout);
    activeTurn.stallTimeout = this.createStallTimeout(session);
  }

  private sendUserTurnSubmission(
    session: KernelSessionProcess,
    submissionId: string,
    items: KernelInputItem[],
    options: KernelUserTurnOptions | undefined,
  ): void {
    this.sendSubmission(session, {
      id: submissionId,
      op: {
        type: 'user_turn',
        items,
        ...(options ? { options } : {}),
      },
    });
  }

  private sendSubmission(session: KernelSessionProcess, submission: unknown): void {
    // Check if child process has already exited (exitCode/signal set by exit handler)
    if (session.exitCode !== null || session.exitSignal !== null) {
      throw new Error(`chat-codex kernel process already exited for session ${session.key}`);
    }
    // Check stdin stream state
    if (!session.child.stdin.writable) {
      throw new Error(`chat-codex kernel stdin is not writable for session ${session.key}`);
    }
    // Additional safety: check child.killed flag
    if (session.child.killed) {
      throw new Error(`chat-codex kernel process already killed for session ${session.key}`);
    }
    try {
          session.child.stdin.write(`${JSON.stringify(submission)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('EPIPE') || message.includes('write after end')) {
        // Child process exited between our check and write — this is a race
        // Mark as exited and throw a retryable error
        session.exitCode = session.child.exitCode ?? 1;
        session.exitSignal = null;
        throw new Error(`chat-codex kernel process exited unexpectedly for session ${session.key}`);
      }
      throw error;
    }
  }

  private disposeSession(session: KernelSessionProcess): void {
    try {
      if (!session.child.killed) {
        session.child.kill('SIGTERM');
      }
    } catch (error) {
      chatCodexLog.warn('Failed to dispose kernel session cleanly', {
        sessionKey: session.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.sessions.delete(session.key);
  }

  private nextSubmissionId(session: KernelSessionProcess, kind: 'turn' | 'pending'): string {
    session.submissionSeq += 1;
    return `${kind}-${Date.now()}-${session.submissionSeq}`;
  }

  private inspectActiveTurnStaleness(activeTurn: ActiveKernelTurn): {
    stale: boolean;
    idleMs: number;
    ageMs: number;
  } {
    const now = Date.now();
    const idleMs = Math.max(0, now - activeTurn.lastKernelEventAtMs);
    const ageMs = Math.max(0, now - activeTurn.startedAtMs);
    const stale = idleMs >= (this.stallTimeoutMs + ACTIVE_TURN_STALE_GRACE_MS)
      || ageMs >= (this.timeoutMs + ACTIVE_TURN_STALE_GRACE_MS);
    return { stale, idleMs, ageMs };
  }
}

export function createChatCodexModule(
  config: Partial<ChatCodexModuleConfig> = {},
  runner?: ChatCodexRunner,
): OutputModule {
  const mergedConfig: ChatCodexModuleConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  const resolveCurrentPromptPaths = () => mergedConfig.resolvePromptPaths?.() ?? {};
  const resolveCodingPrompt = (): string => {
    const resolvedPromptPaths = resolveCurrentPromptPaths();
    return resolveCodingCliSystemPrompt(resolvedPromptPaths.codingPromptPath ?? mergedConfig.codingPromptPath);
  };
  const resolveSystemPrompt = (): string => resolveCodingPrompt();
  const activeRunner =
    runner ??
    new ProcessChatCodexRunner({
      timeoutMs: mergedConfig.timeoutMs,
      binaryPath: mergedConfig.binaryPath,
      toolExecution: mergedConfig.toolExecution,
      developerPromptPaths: mergedConfig.developerPromptPaths,
    });

  const kernelRunner: KernelAgentRunner = {
    runTurn: async (text: string, inputItems?: KernelInputItem[], context?: KernelRunContext) => {
      const resolvedInputItems = inputItems ?? parseKernelInputItems(context?.metadata);
      const normalizedInputItems = normalizeKernelInputItems(resolvedInputItems, text);
      const sessionId = context?.sessionId ?? 'unknown';
      const toolSpecifications = Array.isArray(context?.tools) && context.tools.every((item) => isToolSpecificationLike(item))
        ? normalizeProvidedToolSpecifications(context.tools as ChatCodexToolSpecification[])
        : await resolveToolSpecifications(
            Array.isArray(context?.tools) && context?.tools.every((item) => typeof item === 'string')
              ? (context?.tools as string[])
              : undefined,
            mergedConfig.resolveToolSpecifications,
          );
      const toolSpecificationsForTurn = augmentToolSpecificationsWithCompatAliases(toolSpecifications);
      const mode = parseOptionalString(context?.metadata?.kernelMode) ?? parseOptionalString(context?.metadata?.mode) ?? 'main';
      const contextHistorySource = parseOptionalString(context?.metadata?.contextHistorySource);
      const contextBuilderBypassed = parseOptionalBoolean(context?.metadata?.contextBuilderBypassed);
      const contextBuilderBypassReason = parseOptionalString(context?.metadata?.contextBuilderBypassReason);
      const contextBuilderRebuilt = parseOptionalBoolean(context?.metadata?.contextBuilderRebuilt);
      const contextLedgerAgentId = parseOptionalString(context?.metadata?.contextLedgerAgentId)
        ?? parseOptionalString(context?.metadata?.agentId)
        ?? 'unknown-agent';
      const contextLedgerRole = parseOptionalString(context?.metadata?.contextLedgerRole)
        ?? parseOptionalString(context?.metadata?.roleProfile)
        ?? 'system';
      const reviewMeta = isRecord(context?.metadata?.review) ? context.metadata.review : undefined;
      const reviewIteration = parseOptionalNumber(reviewMeta?.iteration);
      const reviewPhase = parseOptionalString(reviewMeta?.phase);
      const currentPromptPaths = resolveCurrentPromptPaths();
      const snapshotContext: ChatCodexRunContext = {
        sessionId,
        systemPrompt: context?.systemPrompt,
        history: context?.history?.map((item) => ({
          role: item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user',
          content: item.content,
        })),
        metadata: context?.metadata,
        developerPromptPaths: currentPromptPaths.developerPromptPaths ?? mergedConfig.developerPromptPaths,
        tools: toolSpecificationsForTurn,
        toolExecution: mergedConfig.toolExecution,
      };
      const optionsSnapshot = isRecord(snapshotContext.prebuiltOptions)
        ? hydratePrebuiltKernelUserTurnOptions(
            snapshotContext.prebuiltOptions as KernelUserTurnOptions,
            snapshotContext,
            mergedConfig.toolExecution,
            snapshotContext.developerPromptPaths,
          )
        : buildKernelUserTurnOptions(
            snapshotContext,
            mergedConfig.toolExecution,
            snapshotContext.developerPromptPaths,
          );
      const contextBreakdownSnapshot = resolveContextBreakdownSnapshot({
        options: optionsSnapshot,
        metadata: isRecord(context?.metadata) ? context.metadata : undefined,
        mailboxSnapshot: context?.mailboxSnapshot,
        inputItems: normalizedInputItems,
        userText: text,
      });
      writePromptInjectionSnapshot({
        sessionId,
        text,
        systemPrompt: context?.systemPrompt,
        metadata: isRecord(context?.metadata) ? context?.metadata : undefined,
        mailboxSnapshot: context?.mailboxSnapshot,
        roleProfile: parseOptionalString(context?.metadata?.roleProfile) ?? parseOptionalString(context?.metadata?.contextLedgerRole),
        toolSpecifications: toolSpecificationsForTurn,
        inputItems: normalizedInputItems,
        history: snapshotContext.history,
        options: optionsSnapshot,
      });

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_start',
        timestamp: new Date().toISOString(),
        payload: {
          text,
          inputItemCount: normalizedInputItems.length,
          inputTypes: normalizedInputItems.map((item) => item.type),
          toolCount: toolSpecificationsForTurn.length,
          mode,
          agentId: contextLedgerAgentId,
          roleProfile: contextLedgerRole,
          ...(contextHistorySource ? { contextHistorySource } : {}),
          ...(contextBuilderBypassed !== undefined ? { contextBuilderBypassed } : {}),
          ...(contextBuilderBypassReason ? { contextBuilderBypassReason } : {}),
          ...(contextBuilderRebuilt !== undefined ? { contextBuilderRebuilt } : {}),
          ...(reviewPhase ? { reviewPhase } : {}),
          ...(typeof reviewIteration === 'number' ? { reviewIteration } : {}),
          ...(contextBreakdownSnapshot ? { contextBreakdown: contextBreakdownSnapshot } : {}),
        },
      });

      const emittedReasoningKeys = new Set<string>();
      const emittedReasoningTextKeys = new Set<string>();
      const resolveReasoningIdentity = (metadataInput?: Record<string, unknown>): { agentId: string; roleProfile: string } => {
        const agentId = parseOptionalString(context?.metadata?.contextLedgerAgentId)
          ?? parseOptionalString(metadataInput?.contextLedgerAgentId)
          ?? 'unknown-agent';
        const roleProfile = parseOptionalString(context?.metadata?.roleProfile)
          ?? parseOptionalString(context?.metadata?.contextLedgerRole)
          ?? parseOptionalString(metadataInput?.roleProfile)
          ?? 'system';
        return { agentId, roleProfile };
      };
      const markReasoningDedup = (agentId: string, roleProfile: string, text: string, index?: number): void => {
        const normalizedText = text.trim();
        if (!normalizedText) return;
        emittedReasoningTextKeys.add(`${agentId}|${roleProfile}|${normalizedText}`);
        if (typeof index === 'number' && Number.isFinite(index)) {
          emittedReasoningKeys.add(`${agentId}|${roleProfile}|${index}|${normalizedText}`);
        }
      };

      const emitReasoningTraceFromMetadata = (
        event: ChatCodexKernelEvent,
        metadataInput?: Record<string, unknown>,
      ): boolean => {
        const metadata = metadataInput
          ?? (
            event.msg.metadata_json && event.msg.metadata_json.trim().length > 0
              ? parseKernelMetadata(event.msg.metadata_json)
              : undefined
          );
        if (!metadata) return false;

        const reasoningTrace = extractKernelReasoningTrace(metadata);
        if (reasoningTrace.length === 0) return false;

        const identity = resolveReasoningIdentity(metadata);
        const reasoningAgentId = identity.agentId;
        const reasoningRoleProfile = identity.roleProfile;

        let emitted = false;
        for (let i = 0; i < reasoningTrace.length; i += 1) {
          const reasoningText = reasoningTrace[i];
          if (!reasoningText) continue;
          const textDedupKey = `${reasoningAgentId}|${reasoningRoleProfile}|${reasoningText}`;
          if (emittedReasoningTextKeys.has(textDedupKey)) continue;
          const dedupKey = `${reasoningAgentId}|${reasoningRoleProfile}|${i}|${reasoningText}`;
          if (emittedReasoningKeys.has(dedupKey)) continue;
          markReasoningDedup(reasoningAgentId, reasoningRoleProfile, reasoningText, i);
          emitted = true;
          safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
            sessionId,
            phase: 'kernel_event',
            timestamp: new Date().toISOString(),
            payload: {
              id: event.id,
              type: 'reasoning',
              index: i,
              text: reasoningText,
              agentId: reasoningAgentId,
              roleProfile: reasoningRoleProfile,
            },
          });
        }

        return emitted;
      };

      const isRealtimeKernelStepEvent = (eventType: string): boolean =>
        eventType === 'tool_call'
        || eventType === 'tool_result'
        || eventType === 'tool_error'
        || eventType === 'model_round';

      const emitSyntheticKernelEventsFromTaskComplete = (
        event: ChatCodexKernelEvent,
        options?: {
          emitModelRound?: boolean;
          emitToolTrace?: boolean;
          emitReasoning?: boolean;
        },
      ): boolean => {
        const emitModelRound = options?.emitModelRound !== false;
        const emitToolTrace = options?.emitToolTrace !== false;
        const emitReasoning = options?.emitReasoning !== false;
        if (
          event.msg.type !== 'task_complete'
          || !event.msg.metadata_json
          || event.msg.metadata_json.trim().length === 0
        ) {
          return false;
        }

        const metadata = parseKernelMetadata(event.msg.metadata_json);
        if (!metadata) return false;

        let emitted = false;
        if (emitModelRound) {
          const roundTrace = extractKernelRoundTrace(metadata);
          for (const round of roundTrace) {
            emitted = true;
            safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
              sessionId,
              phase: 'kernel_event',
              timestamp: new Date().toISOString(),
              payload: {
                id: event.id,
                type: 'model_round',
                ...(typeof round.seq === 'number' ? { seq: round.seq } : {}),
                round: round.round,
                ...(round.functionCallsCount !== undefined ? { functionCallsCount: round.functionCallsCount } : {}),
                ...(round.reasoningCount !== undefined ? { reasoningCount: round.reasoningCount } : {}),
                ...(round.historyItemsCount !== undefined ? { historyItemsCount: round.historyItemsCount } : {}),
                ...(round.hasOutputText !== undefined ? { hasOutputText: round.hasOutputText } : {}),
                ...(round.finishReason ? { finishReason: round.finishReason } : {}),
                ...(round.responseStatus ? { responseStatus: round.responseStatus } : {}),
                ...(round.responseIncompleteReason ? { responseIncompleteReason: round.responseIncompleteReason } : {}),
                ...(round.responseId ? { responseId: round.responseId } : {}),
                ...(round.inputTokens !== undefined ? { inputTokens: round.inputTokens } : {}),
                ...(round.outputTokens !== undefined ? { outputTokens: round.outputTokens } : {}),
                ...(round.totalTokens !== undefined ? { totalTokens: round.totalTokens } : {}),
                ...(round.estimatedTokensInContextWindow !== undefined
                  ? { estimatedTokensInContextWindow: round.estimatedTokensInContextWindow }
                  : {}),
                ...(round.estimatedTokensCompactable !== undefined
                  ? { estimatedTokensCompactable: round.estimatedTokensCompactable }
                  : {}),
                ...(round.contextUsagePercent !== undefined ? { contextUsagePercent: round.contextUsagePercent } : {}),
                ...(round.maxInputTokens !== undefined ? { maxInputTokens: round.maxInputTokens } : {}),
                ...(round.thresholdPercent !== undefined ? { thresholdPercent: round.thresholdPercent } : {}),
                agentId: contextLedgerAgentId,
                roleProfile: contextLedgerRole,
                ...(contextBreakdownSnapshot ? { contextBreakdown: contextBreakdownSnapshot } : {}),
              },
            });
          }
        }

        if (emitToolTrace) {
          const toolTrace = extractKernelToolTrace(metadata);
          for (const trace of toolTrace) {
            emitted = true;
            safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
              sessionId,
              phase: 'kernel_event',
              timestamp: new Date().toISOString(),
              payload: {
                id: event.id,
                type: 'tool_call',
                ...(typeof trace.seq === 'number' ? { seq: trace.seq } : {}),
                toolName: trace.tool,
                ...(trace.callId ? { toolId: trace.callId } : {}),
                ...(trace.input !== undefined ? { input: trace.input } : {}),
              },
            });

            safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
              sessionId,
              phase: 'kernel_event',
              timestamp: new Date().toISOString(),
              payload: {
                id: event.id,
                type: trace.status === 'ok' ? 'tool_result' : 'tool_error',
                ...(typeof trace.seq === 'number' ? { seq: trace.seq } : {}),
                toolName: trace.tool,
                ...(trace.callId ? { toolId: trace.callId } : {}),
                ...(typeof trace.durationMs === 'number' ? { duration: trace.durationMs } : {}),
                ...(trace.status === 'ok'
                  ? (trace.output !== undefined ? { output: trace.output } : {})
                  : { error: trace.error ?? `工具执行失败：${trace.tool}` }),
              },
            });
          }
        }

        if (emitReasoning) {
          emitted = emitReasoningTraceFromMetadata(event, metadata) || emitted;
        }

        return emitted;
      };

      const emitKernelEvent = (
        event: ChatCodexKernelEvent,
        options: { markSyntheticToolEvents?: boolean; markRealtimeToolEvents?: boolean } = {},
      ): void => {
        const payload: Record<string, unknown> = {
          id: event.id,
          type: event.msg.type,
          ...(typeof event.msg.seq === 'number' ? { seq: event.msg.seq } : {}),
          ...(event.msg.message ? { message: event.msg.message } : {}),
          ...(event.msg.last_agent_message ? { lastAgentMessage: event.msg.last_agent_message } : {}),
        };
        if (event.msg.type === 'reasoning') {
          const reasoningText = parseOptionalString(event.msg.message)
            ?? parseOptionalString(event.msg.last_agent_message);
          if (reasoningText) {
            const metadata = event.msg.metadata_json && event.msg.metadata_json.trim().length > 0
              ? parseKernelMetadata(event.msg.metadata_json)
              : undefined;
            const identity = resolveReasoningIdentity(metadata);
            payload.text = reasoningText;
            payload.agentId = identity.agentId;
            payload.roleProfile = identity.roleProfile;
            markReasoningDedup(identity.agentId, identity.roleProfile, reasoningText);
          }
        } else if (event.msg.type === 'tool_call') {
          if (event.msg.tool_name) payload.toolName = event.msg.tool_name;
          if (event.msg.call_id) payload.toolId = event.msg.call_id;
          if (event.msg.input !== undefined) payload.input = event.msg.input;
        } else if (event.msg.type === 'tool_result') {
          if (event.msg.tool_name) payload.toolName = event.msg.tool_name;
          if (event.msg.call_id) payload.toolId = event.msg.call_id;
          if (event.msg.output !== undefined) payload.output = event.msg.output;
          if (typeof event.msg.duration_ms === 'number') payload.duration = event.msg.duration_ms;
        } else if (event.msg.type === 'tool_error') {
          if (event.msg.tool_name) payload.toolName = event.msg.tool_name;
          if (event.msg.call_id) payload.toolId = event.msg.call_id;
          if (event.msg.error) {
            const rawError = event.msg.error;
            // 检测工具不存在错误，替换成引导性消息避免 LLM 重试错误工具
            if (typeof rawError === 'string' && /Tool\s+[a-zA-Z0-9_.-]+\s+does(?:\s+not)?\s+exist/i.test(rawError)) {
              // 提取尝试调用的工具名
              const toolMatch = rawError.match(/Tool\s+([a-zA-Z0-9_.-]+)/);
              const attemptedTool = toolMatch ? toolMatch[1] : 'unknown';
              // 替换为引导性消息：明确告知可用工具列表格式
              payload.error = `工具 '${attemptedTool}' 不在当前可用工具列表中。请检查工具名称是否正确（使用点分隔格式如 'command.exec' 或 'mailbox.status'），或使用 'agent.capabilities' 查看当前可用工具。`;
              chatCodexLog.warn('[chat-codex] Tool registry unavailable error detected, replacing error message', {
                attemptedTool,
                rawError: rawError.slice(0, 200),
              });
            } else {
              payload.error = rawError;
            }
          }
          if (typeof event.msg.duration_ms === 'number') payload.duration = event.msg.duration_ms;
        } else if (event.msg.type === 'model_round') {
          payload.agentId = contextLedgerAgentId;
          payload.roleProfile = contextLedgerRole;
          if (typeof event.msg.round === 'number') payload.round = event.msg.round;
          if (typeof event.msg.function_calls_count === 'number') payload.functionCallsCount = event.msg.function_calls_count;
          if (typeof event.msg.reasoning_count === 'number') payload.reasoningCount = event.msg.reasoning_count;
          if (typeof event.msg.history_items_count === 'number') payload.historyItemsCount = event.msg.history_items_count;
          if (typeof event.msg.has_output_text === 'boolean') payload.hasOutputText = event.msg.has_output_text;
          if (typeof event.msg.finish_reason === 'string' && event.msg.finish_reason.trim().length > 0) {
            payload.finishReason = event.msg.finish_reason.trim();
          }
          if (typeof event.msg.response_status === 'string' && event.msg.response_status.trim().length > 0) {
            payload.responseStatus = event.msg.response_status.trim();
          }
          if (
            typeof event.msg.response_incomplete_reason === 'string' &&
            event.msg.response_incomplete_reason.trim().length > 0
          ) {
            payload.responseIncompleteReason = event.msg.response_incomplete_reason.trim();
          }
          if (typeof event.msg.response_id === 'string' && event.msg.response_id.trim().length > 0) {
            payload.responseId = event.msg.response_id.trim();
          }
          if (typeof event.msg.input_tokens === 'number') payload.inputTokens = event.msg.input_tokens;
          if (typeof event.msg.output_tokens === 'number') payload.outputTokens = event.msg.output_tokens;
          if (typeof event.msg.total_tokens === 'number') payload.totalTokens = event.msg.total_tokens;
          if (typeof event.msg.estimated_tokens_in_context_window === 'number') {
            payload.estimatedTokensInContextWindow = event.msg.estimated_tokens_in_context_window;
          }
          if (typeof event.msg.estimated_tokens_compactable === 'number') {
            payload.estimatedTokensCompactable = event.msg.estimated_tokens_compactable;
          }
          if (typeof event.msg.context_usage_percent === 'number') payload.contextUsagePercent = event.msg.context_usage_percent;
          if (typeof event.msg.max_input_tokens === 'number') payload.maxInputTokens = event.msg.max_input_tokens;
          if (typeof event.msg.threshold_percent === 'number') payload.thresholdPercent = event.msg.threshold_percent;
          if (contextBreakdownSnapshot) payload.contextBreakdown = contextBreakdownSnapshot;
        } else if (event.msg.type === 'task_started') {
          if (typeof event.msg.model_context_window === 'number') {
            payload.modelContextWindow = event.msg.model_context_window;
          }
        }

        if (event.msg.metadata_json && event.msg.metadata_json.trim().length > 0) {
          const metadata = parseKernelMetadata(event.msg.metadata_json);
          if (metadata) {
            const toolTrace = extractKernelToolTrace(metadata);
            if (toolTrace.length > 0) {
              payload.toolTrace = toolTrace;
              payload.toolTraceCount = toolTrace.length;
              if (options.markSyntheticToolEvents) {
                payload.syntheticToolEvents = true;
              }
              if (options.markRealtimeToolEvents) {
                payload.realtimeToolEvents = true;
              }
            }
            emitReasoningTraceFromMetadata(event, metadata);
          }
        }

        safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
          sessionId,
          phase: 'kernel_event',
          timestamp: new Date().toISOString(),
          payload,
        });
      };

      let streamedKernelEventCount = 0;
      let streamedRealtimeKernelStepCount = 0;
      let streamedModelRoundCount = 0;

      const normalizedTimeoutRetryCount = Number.isFinite(mergedConfig.timeoutRetryCount)
        ? Math.max(0, Math.floor(mergedConfig.timeoutRetryCount))
        : DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT;
      const maxAttempts = normalizedTimeoutRetryCount + 1;
      let runResult: ChatCodexRunResult | null = null;
      let lastRunError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          runResult = await activeRunner.runTurn(text, normalizedInputItems, {
            sessionId,
            systemPrompt: context?.systemPrompt,
            history: context?.history,
            metadata: context?.metadata,
            developerPromptPaths: currentPromptPaths.developerPromptPaths ?? mergedConfig.developerPromptPaths,
            tools: toolSpecificationsForTurn,
            toolExecution: mergedConfig.toolExecution,
            onKernelEvent: (event) => {
              streamedKernelEventCount += 1;
              if (isRealtimeKernelStepEvent(event.msg.type)) {
                streamedRealtimeKernelStepCount += 1;
              }
              if (event.msg.type === 'model_round') {
                streamedModelRoundCount += 1;
              }
              emitKernelEvent(event, {
                markRealtimeToolEvents:
                  event.msg.type === 'task_complete' && streamedRealtimeKernelStepCount > 0,
              });
            },
          });
          break;
        } catch (error) {
          lastRunError = error;
          const retryable = isRetryableRunError(error);
          const errorMessage = error instanceof Error ? error.message : String(error);
          const normalizedError = errorMessage.toLowerCase();
          const errorCategory = isTimeoutError(error)
            ? 'timeout'
            : normalizedError.includes('stalled')
              ? 'stall'
              : normalizedError.includes('no endpoints found for')
                ? 'routing_unavailable'
              : normalizedError.includes('completed response payload')
                || normalizedError.includes('response stream ended prematurely')
                || normalizedError.includes('stream ended before completed response')
                ? 'stream_incomplete'
                : normalizedError.includes('interrupted')
                  ? 'interrupted'
                  : 'fatal';
          if (retryable && attempt < maxAttempts) {
            const delayMs = retryDelayMs(attempt);
            safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
              sessionId,
              phase: 'kernel_event',
              timestamp: new Date().toISOString(),
              payload: {
                type: 'turn_retry',
                attempt,
                maxAttempts,
                timeoutMs: mergedConfig.timeoutMs,
                retryDelayMs: delayMs,
                error: errorMessage,
                retryable: true,
                recoveryAction: 'retry',
                errorCategory,
              },
            });
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
            sessionId,
            phase: 'turn_error',
            timestamp: new Date().toISOString(),
            payload: {
              error: errorMessage,
              attempt,
              maxAttempts,
              timeoutRetryCount: normalizedTimeoutRetryCount,
              retryable: false,
              recoveryAction: errorCategory === 'interrupted' ? 'interrupted' : 'failed',
              errorCategory,
            },
          });
          throw error;
        }
      }
      if (!runResult) {
        const fallbackError = lastRunError instanceof Error
          ? lastRunError
          : new Error('chat-codex failed without result');
        safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
          sessionId,
          phase: 'turn_error',
          timestamp: new Date().toISOString(),
          payload: {
            error: fallbackError.message,
            maxAttempts,
            timeoutRetryCount: normalizedTimeoutRetryCount,
            retryable: false,
            recoveryAction: 'failed',
            errorCategory: 'fatal',
          },
        });
        throw fallbackError;
      }

      if (streamedKernelEventCount === 0) {
        const hasRealtimeKernelSteps = runResult.events.some((event) =>
          isRealtimeKernelStepEvent(event.msg.type),
        );
        for (const event of runResult.events) {
          const syntheticKernelEventsEmitted = !hasRealtimeKernelSteps
            ? emitSyntheticKernelEventsFromTaskComplete(event)
            : false;
          emitKernelEvent(event, { markSyntheticToolEvents: syntheticKernelEventsEmitted || hasRealtimeKernelSteps });
        }
      } else if (streamedRealtimeKernelStepCount === 0) {
        // If streaming path produced only boundary events, recover tool/model steps from metadata traces.
        for (const event of runResult.events) {
          emitSyntheticKernelEventsFromTaskComplete(event);
        }
      } else {
        if (streamedModelRoundCount === 0) {
          // Some streamed providers emit tool_call/tool_result but omit model_round.
          // Backfill model_round from task_complete metadata to keep context telemetry stable.
          for (const event of runResult.events) {
            emitSyntheticKernelEventsFromTaskComplete(event, {
              emitModelRound: true,
              emitToolTrace: false,
              emitReasoning: false,
            });
          }
        }
        // Streaming path may still carry reasoning trace inside metadata_json.
        // Re-scan final events as a fallback; turn-level dedup prevents duplicate pushes.
        for (const event of runResult.events) {
          emitReasoningTraceFromMetadata(event);
        }
      }

      const stopReason = resolveStopReasonFromKernelMetadata(runResult.kernelMetadata);
      const controlPolicy = resolveControlBlockPolicy(isRecord(context?.metadata) ? context.metadata : undefined);
      const controlParsed = controlPolicy.enabled
        ? parseControlBlockFromReply(runResult.reply)
        : {
          present: false,
          valid: true,
          repaired: false,
          humanResponse: runResult.reply,
          issues: [] as string[],
          controlBlock: undefined,
        };
      const controlHooks = controlParsed.controlBlock
        ? evaluateControlHooks(controlParsed.controlBlock)
        : { hooks: [] as string[], holdStop: false };
      const normalizedReply = controlPolicy.enabled
        ? (controlParsed.humanResponse.trim().length > 0 ? controlParsed.humanResponse : runResult.reply)
        : runResult.reply;
      const controlGateHold = controlPolicy.enabled
        && controlPolicy.requireOnStop
        && shouldHoldStopByControlBlock({
          finishReasonStop: stopReason === 'stop',
          parsed: controlParsed,
          hooks: controlHooks,
          yoloMode: controlPolicy.autonomyMode === 'yolo',
        });
      const kernelMetadata = isRecord(runResult.kernelMetadata) ? runResult.kernelMetadata : {};
      const stopToolGateApplied = kernelMetadata.stopToolGateApplied === true;
      const stopToolGateAttempt = typeof kernelMetadata.stopToolGateAttempt === 'number'
        && Number.isFinite(kernelMetadata.stopToolGateAttempt)
        && kernelMetadata.stopToolGateAttempt >= 0
        ? Math.floor(kernelMetadata.stopToolGateAttempt)
        : undefined;
      const stopToolMaxAutoContinueTurns = typeof kernelMetadata.stopToolMaxAutoContinueTurns === 'number'
        && Number.isFinite(kernelMetadata.stopToolMaxAutoContinueTurns)
        && kernelMetadata.stopToolMaxAutoContinueTurns >= 0
        ? Math.floor(kernelMetadata.stopToolMaxAutoContinueTurns)
        : undefined;
      const controlBlockGateApplied = kernelMetadata.controlBlockGateApplied === true;
      const controlBlockGateAttempt = typeof kernelMetadata.controlBlockGateAttempt === 'number'
        && Number.isFinite(kernelMetadata.controlBlockGateAttempt)
        && kernelMetadata.controlBlockGateAttempt >= 0
        ? Math.floor(kernelMetadata.controlBlockGateAttempt)
        : undefined;
      const controlBlockMaxAutoContinueTurns = typeof kernelMetadata.controlBlockMaxAutoContinueTurns === 'number'
        && Number.isFinite(kernelMetadata.controlBlockMaxAutoContinueTurns)
        && kernelMetadata.controlBlockMaxAutoContinueTurns >= 0
        ? Math.floor(kernelMetadata.controlBlockMaxAutoContinueTurns)
        : undefined;

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_complete',
        timestamp: new Date().toISOString(),
        payload: {
          replyPreview: normalizedReply.slice(0, 300),
          eventCount: runResult.events.length,
          finalKernelEvent: runResult.events.length > 0 ? runResult.events[runResult.events.length - 1].msg.type : null,
          mode,
          timeoutMs: mergedConfig.timeoutMs,
          timeoutRetryCount: normalizedTimeoutRetryCount,
          finishReason: stopReason,
          controlBlockPresent: controlParsed.present,
          controlBlockValid: controlParsed.valid,
          controlBlockIssues: controlParsed.issues.slice(0, 8),
          controlHookNames: controlHooks.hooks.slice(0, 32),
          controlGateHold,
          ...(typeof stopToolMaxAutoContinueTurns === 'number'
            ? { stopToolMaxAutoContinueTurns }
            : {}),
          ...(stopToolGateApplied || typeof stopToolGateAttempt === 'number'
            ? { stopToolGateApplied }
            : {}),
          ...(typeof stopToolGateAttempt === 'number'
            ? { stopToolGateAttempt }
            : {}),
          ...(typeof controlBlockMaxAutoContinueTurns === 'number'
            ? { controlBlockMaxAutoContinueTurns }
            : {}),
          ...(controlBlockGateApplied || typeof controlBlockGateAttempt === 'number'
            ? { controlBlockGateApplied }
            : {}),
          ...(typeof controlBlockGateAttempt === 'number'
            ? { controlBlockGateAttempt }
            : {}),
          ...(controlParsed.controlBlock ? { controlBlock: controlParsed.controlBlock } : {}),
          ...(runResult.kernelMetadata?.pendingInputAccepted === true ? { pendingInputAccepted: true } : {}),
          ...(typeof runResult.kernelMetadata?.activeTurnId === 'string'
            ? { activeTurnId: runResult.kernelMetadata.activeTurnId }
            : {}),
          ...(typeof runResult.kernelMetadata?.pendingTurnId === 'string'
            ? { pendingTurnId: runResult.kernelMetadata.pendingTurnId }
            : {}),
          ...(reviewPhase ? { reviewPhase } : {}),
          ...(typeof reviewIteration === 'number' ? { reviewIteration } : {}),
        },
      });

      // finish_reason = stop 时自动生成 digest + 保存 tags
      if (stopReason === "stop" && mergedConfig.digestProvider) {
        const tags = controlParsed.controlBlock?.tags || [];
        const agentIdForDigest = parseOptionalString(context?.metadata?.contextLedgerAgentId)
          ?? parseOptionalString(context?.metadata?.agentId)
          ?? "finger-system-agent";
        const modeForDigest = mode;
        
        // 构建当前轮的 digest message
        const digestMessage = {
          id: `msg-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
          role: "assistant" as const,
          content: normalizedReply.slice(0, 500),
          timestamp: new Date().toISOString(),
        };
        
        try {
          await mergedConfig.digestProvider(sessionId, digestMessage, tags, agentIdForDigest, modeForDigest);
        } catch (digestError) {
          chatCodexLog.warn("[digestProvider] Failed to append digest", {
            sessionId,
            error: digestError instanceof Error ? digestError.message : String(digestError),
          });
        }
      }

      return {
        reply: normalizedReply,
        metadata: {
          binaryPath: runResult.usedBinaryPath,
          eventCount: runResult.events.length,
          kernelEventTypes: runResult.events.map((event) => event.msg.type),
          stopReason,
          controlBlockPresent: controlParsed.present,
          controlBlockValid: controlParsed.valid,
          controlBlockIssues: controlParsed.issues,
          controlHookNames: controlHooks.hooks,
          controlGateHold,
          ...(controlParsed.controlBlock ? { controlBlock: controlParsed.controlBlock } : {}),
          ...(runResult.kernelMetadata ?? {}),
        },
      };
    },
  };

  const kernelAgent = new KernelAgentBase(
    {
      moduleId: mergedConfig.id,
      provider: 'codex',
      defaultSystemPromptResolver: resolveSystemPrompt,
      defaultRoleProfileId: normalizeDefaultRoleProfileId(mergedConfig.defaultRoleProfileId),
      appendContextSlotsToSystemPrompt: false,
      // Context history is budgeted by token-aware context builder (task-granularity),
      // not by message count.
      maxContextMessages: 0,
      roleProfiles: {
        general: {
          id: 'general',
          allowedTools: CHAT_CODEX_PROJECT_ALLOWED_TOOLS,
        },
        project: {
          id: 'project',
          allowedTools: CHAT_CODEX_PROJECT_ALLOWED_TOOLS,
        },
        system: {
          id: 'system',
          allowedTools: CHAT_CODEX_SYSTEM_ALLOWED_TOOLS,
        },
      },
      messageHub: mergedConfig.messageHub,
      contextHistoryProvider: mergedConfig.contextHistoryProvider,
  },
  kernelRunner,
  mergedConfig.sessionManager ?? (() => {
    const sm = new SessionManager();
    return sm as unknown as ISessionManager;
  })(),
);

  return {
    id: mergedConfig.id,
    type: 'output',
    name: mergedConfig.name,
    version: mergedConfig.version,
    metadata: {
      provider: 'codex',
      bridge: 'rust-kernel',
      role: normalizeDefaultRoleProfileId(mergedConfig.defaultRoleProfileId),
    },
    handle: async (message: unknown, callback?: (result: unknown) => void): Promise<unknown> => {
      const response = (await kernelAgent.handle(message)) as ChatCodexResponse;
      if (callback) callback(response);
      return response;
    },
  };
}

function parseKernelEvent(line: string): ChatCodexKernelEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (typeof parsed.id !== 'string') return null;
  if (!isRecord(parsed.msg)) return null;
  if (typeof parsed.msg.type !== 'string') return null;

  const event: ChatCodexKernelEvent = {
    id: parsed.id,
    msg: {
      type: parsed.msg.type,
    },
  };

  if (typeof parsed.msg.last_agent_message === 'string') {
    event.msg.last_agent_message = parsed.msg.last_agent_message;
  }
  if (typeof parsed.msg.message === 'string') {
    event.msg.message = parsed.msg.message;
  }
  if (typeof parsed.msg.metadata_json === 'string') {
    event.msg.metadata_json = parsed.msg.metadata_json;
  }
  if (typeof parsed.msg.call_id === 'string') {
    event.msg.call_id = parsed.msg.call_id;
  }
  if (typeof parsed.msg.tool_name === 'string') {
    event.msg.tool_name = parsed.msg.tool_name;
  }
  if (parsed.msg.input !== undefined) {
    event.msg.input = parsed.msg.input;
  }
  if (parsed.msg.output !== undefined) {
    event.msg.output = parsed.msg.output;
  }
  if (typeof parsed.msg.error === 'string') {
    event.msg.error = parsed.msg.error;
  }
  if (typeof parsed.msg.duration_ms === 'number' && Number.isFinite(parsed.msg.duration_ms)) {
    event.msg.duration_ms = Math.round(parsed.msg.duration_ms);
  }
  if (typeof parsed.msg.round === 'number' && Number.isFinite(parsed.msg.round)) {
    event.msg.round = Math.round(parsed.msg.round);
  }
  if (typeof parsed.msg.function_calls_count === 'number' && Number.isFinite(parsed.msg.function_calls_count)) {
    event.msg.function_calls_count = Math.round(parsed.msg.function_calls_count);
  }
  if (typeof parsed.msg.reasoning_count === 'number' && Number.isFinite(parsed.msg.reasoning_count)) {
    event.msg.reasoning_count = Math.round(parsed.msg.reasoning_count);
  }
  if (typeof parsed.msg.history_items_count === 'number' && Number.isFinite(parsed.msg.history_items_count)) {
    event.msg.history_items_count = Math.round(parsed.msg.history_items_count);
  }
  if (typeof parsed.msg.has_output_text === 'boolean') {
    event.msg.has_output_text = parsed.msg.has_output_text;
  }
  if (typeof parsed.msg.seq === 'number' && Number.isFinite(parsed.msg.seq)) {
    event.msg.seq = Math.max(0, Math.floor(parsed.msg.seq));
  }
  if (typeof parsed.msg.finish_reason === 'string' && parsed.msg.finish_reason.trim().length > 0) {
    event.msg.finish_reason = parsed.msg.finish_reason.trim();
  }
  if (typeof parsed.msg.response_status === 'string' && parsed.msg.response_status.trim().length > 0) {
    event.msg.response_status = parsed.msg.response_status.trim();
  }
  if (
    typeof parsed.msg.response_incomplete_reason === 'string'
    && parsed.msg.response_incomplete_reason.trim().length > 0
  ) {
    event.msg.response_incomplete_reason = parsed.msg.response_incomplete_reason.trim();
  }
  if (typeof parsed.msg.response_id === 'string' && parsed.msg.response_id.trim().length > 0) {
    event.msg.response_id = parsed.msg.response_id.trim();
  }
  if (typeof parsed.msg.input_tokens === 'number' && Number.isFinite(parsed.msg.input_tokens) && parsed.msg.input_tokens >= 0) {
    event.msg.input_tokens = Math.floor(parsed.msg.input_tokens);
  }
  if (typeof parsed.msg.output_tokens === 'number' && Number.isFinite(parsed.msg.output_tokens) && parsed.msg.output_tokens >= 0) {
    event.msg.output_tokens = Math.floor(parsed.msg.output_tokens);
  }
  if (typeof parsed.msg.total_tokens === 'number' && Number.isFinite(parsed.msg.total_tokens) && parsed.msg.total_tokens >= 0) {
    event.msg.total_tokens = Math.floor(parsed.msg.total_tokens);
  }
  if (
    typeof parsed.msg.estimated_tokens_in_context_window === 'number'
    && Number.isFinite(parsed.msg.estimated_tokens_in_context_window)
    && parsed.msg.estimated_tokens_in_context_window >= 0
  ) {
    event.msg.estimated_tokens_in_context_window = Math.floor(parsed.msg.estimated_tokens_in_context_window);
  }
  if (
    typeof parsed.msg.estimated_tokens_compactable === 'number'
    && Number.isFinite(parsed.msg.estimated_tokens_compactable)
    && parsed.msg.estimated_tokens_compactable >= 0
  ) {
    event.msg.estimated_tokens_compactable = Math.floor(parsed.msg.estimated_tokens_compactable);
  }
  if (
    typeof parsed.msg.context_usage_percent === 'number'
    && Number.isFinite(parsed.msg.context_usage_percent)
    && parsed.msg.context_usage_percent >= 0
  ) {
    event.msg.context_usage_percent = Math.floor(parsed.msg.context_usage_percent);
  }
  if (typeof parsed.msg.max_input_tokens === 'number' && Number.isFinite(parsed.msg.max_input_tokens) && parsed.msg.max_input_tokens >= 0) {
    event.msg.max_input_tokens = Math.floor(parsed.msg.max_input_tokens);
  }
  if (typeof parsed.msg.threshold_percent === 'number' && Number.isFinite(parsed.msg.threshold_percent) && parsed.msg.threshold_percent >= 0) {
    event.msg.threshold_percent = Math.floor(parsed.msg.threshold_percent);
  }
  if (
    typeof parsed.msg.model_context_window === 'number'
    && Number.isFinite(parsed.msg.model_context_window)
    && parsed.msg.model_context_window >= 0
  ) {
    event.msg.model_context_window = Math.floor(parsed.msg.model_context_window);
  }

  return event;
}

function writePromptInjectionSnapshot(input: {
  sessionId: string;
  text: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  mailboxSnapshot?: MailboxSnapshot;
  roleProfile?: string;
  toolSpecifications: ChatCodexToolSpecification[];
  inputItems?: KernelInputItem[];
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  options?: KernelUserTurnOptions;
}): void {
  try {
    const agentId = parseOptionalString(input.metadata?.contextLedgerAgentId) ?? 'unknown-agent';
    const roleProfile = parseOptionalString(input.roleProfile) ?? 'project';
    const filePath = resolvePromptInjectionLogPath(input.sessionId, input.metadata, agentId);
    const resolvedSystemPrompt = parseOptionalString(input.systemPrompt)
      ?? parseOptionalString(input.options?.system_prompt);
    const developerInstructions = parseOptionalString(input.options?.developer_instructions);
    const historyItems = Array.isArray(input.options?.history_items) ? input.options?.history_items : [];
    const mailboxSnapshot = input.mailboxSnapshot;
    const mailboxSummary = mailboxSnapshot
      ? {
          currentSeq: mailboxSnapshot.currentSeq,
          hasUnread: mailboxSnapshot.hasUnread,
          entryCount: Array.isArray(mailboxSnapshot.entries) ? mailboxSnapshot.entries.length : 0,
          lastNotifiedSeq: mailboxSnapshot.lastNotifiedSeq ?? null,
        }
      : null;
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: input.sessionId,
      agentId,
      roleProfile,
      userGoal: input.text,
      systemPrompt: resolvedSystemPrompt ?? null,
      inputItems: input.inputItems ?? null,
      history: input.history ?? null,
      metadata: input.metadata ?? null,
      tools: input.toolSpecifications,
      toolList: input.toolSpecifications.map((item) => item.name),
      codexAlignedContext: {
        system_prompt: resolvedSystemPrompt ?? null,
        developer_instructions: developerInstructions ?? null,
        user_input: input.text,
        user_input_items: input.inputItems ?? null,
        history_items_count: historyItems.length,
        mailbox_snapshot: mailboxSummary,
      },
      injections: {
        developerInstructions: developerInstructions ?? null,
        userInstructions: input.options?.user_instructions ?? null,
        environmentContext: input.options?.environment_context ?? null,
        turnContext: input.options?.turn_context ?? null,
        contextLedger: input.options?.context_ledger ?? null,
        mode: input.options?.mode ?? null,
        toolExecution: input.options?.tool_execution ?? null,
        options: input.options ?? null,
      },
      review: isRecord(input.metadata?.review) ? input.metadata?.review : null,
    };
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Best effort only; never break runtime turn.
  }
}

function resolvePromptInjectionLogPath(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  agentId: string,
): string {
  const rootCandidate = parseOptionalString(metadata?.contextLedgerRootDir) ?? parseOptionalString(metadata?.contextLedgerRoot);
  let sessionRoot: string;
  if (rootCandidate) {
    const normalizedBase = basename(rootCandidate) === 'memory' ? dirname(rootCandidate) : rootCandidate;
    const candidateSessionRoot = basename(normalizedBase) === sessionId
      ? normalizedBase
      : join(normalizedBase, normalizeSessionDirName(sanitizePathPart(sessionId)));
    sessionRoot = existsSync(candidateSessionRoot) ? candidateSessionRoot : normalizedBase;
  } else {
    sessionRoot = resolveFallbackSessionRoot(sessionId);
  }
  const diagnosticsDir = join(sessionRoot, 'diagnostics');
  mkdirSync(diagnosticsDir, { recursive: true });
  return join(diagnosticsDir, `${sanitizePathPart(agentId)}.prompt-injection.jsonl`);
}

function resolveFallbackSessionRoot(sessionId: string): string {
  const projectBucket = '_unknown';
  const dir = join(
    FINGER_PATHS.sessions.dir,
    projectBucket,
    normalizeSessionDirName(sanitizePathPart(sessionId)),
  );
  ensureDir(dir);
  return dir;
}

function sanitizePathPart(value: string): string {
  const normalized = value.trim();
  if (!normalized) return 'unknown';
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeDefaultRoleProfileId(role?: string): string {
  const normalized = (role ?? '').trim().toLowerCase();
  if (normalized === 'system') return 'system';
  return 'project';
}

function parseKernelMetadata(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function extractKernelToolTrace(metadata: Record<string, unknown>): KernelToolTraceItem[] {
  const raw = metadata.tool_trace;
  if (!Array.isArray(raw)) return [];

  const result: KernelToolTraceItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
    if (!tool) continue;
    const status: KernelToolTraceItem['status'] = item.status === 'error' ? 'error' : 'ok';
    const callId = typeof item.call_id === 'string' && item.call_id.trim().length > 0 ? item.call_id.trim() : undefined;
    const error = typeof item.error === 'string' && item.error.trim().length > 0 ? item.error.trim() : undefined;
    const durationMs = typeof item.duration_ms === 'number' && Number.isFinite(item.duration_ms) && item.duration_ms >= 0
      ? Math.round(item.duration_ms)
      : undefined;
    const seq = typeof item.seq === 'number' && Number.isFinite(item.seq) && item.seq >= 0
      ? Math.floor(item.seq)
      : undefined;

    result.push({
      ...(seq !== undefined ? { seq } : {}),
      ...(callId ? { callId } : {}),
      tool,
      status,
      ...(item.input !== undefined ? { input: item.input } : {}),
      ...(item.output !== undefined ? { output: item.output } : {}),
      ...(error ? { error } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  return result;
}

function extractKernelRoundTrace(metadata: Record<string, unknown>): KernelRoundTraceItem[] {
  const raw = metadata.round_trace;
  if (!Array.isArray(raw)) return [];

  const result: KernelRoundTraceItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const round = typeof item.round === 'number' && Number.isFinite(item.round) ? Math.floor(item.round) : NaN;
    if (!Number.isFinite(round) || round <= 0) continue;
    const functionCallsCount =
      typeof item.function_calls_count === 'number' && Number.isFinite(item.function_calls_count)
        ? Math.max(0, Math.floor(item.function_calls_count))
        : undefined;
    const reasoningCount =
      typeof item.reasoning_count === 'number' && Number.isFinite(item.reasoning_count)
        ? Math.max(0, Math.floor(item.reasoning_count))
        : undefined;
    const historyItemsCount =
      typeof item.history_items_count === 'number' && Number.isFinite(item.history_items_count)
        ? Math.max(0, Math.floor(item.history_items_count))
        : undefined;
    const hasOutputText = typeof item.has_output_text === 'boolean' ? item.has_output_text : undefined;
    const finishReason =
      typeof item.finish_reason === 'string' && item.finish_reason.trim().length > 0
        ? item.finish_reason.trim()
        : undefined;
    const responseStatus =
      typeof item.response_status === 'string' && item.response_status.trim().length > 0
        ? item.response_status.trim()
        : undefined;
    const responseIncompleteReason =
      typeof item.response_incomplete_reason === 'string' && item.response_incomplete_reason.trim().length > 0
        ? item.response_incomplete_reason.trim()
        : undefined;
    const responseId =
      typeof item.response_id === 'string' && item.response_id.trim().length > 0
        ? item.response_id.trim()
        : undefined;
    const inputTokens =
      typeof item.input_tokens === 'number' && Number.isFinite(item.input_tokens) && item.input_tokens >= 0
        ? Math.floor(item.input_tokens)
        : undefined;
    const outputTokens =
      typeof item.output_tokens === 'number' && Number.isFinite(item.output_tokens) && item.output_tokens >= 0
        ? Math.floor(item.output_tokens)
        : undefined;
    const totalTokens =
      typeof item.total_tokens === 'number' && Number.isFinite(item.total_tokens) && item.total_tokens >= 0
        ? Math.floor(item.total_tokens)
        : undefined;
    const estimatedTokensInContextWindow =
      typeof item.estimated_tokens_in_context_window === 'number'
      && Number.isFinite(item.estimated_tokens_in_context_window)
      && item.estimated_tokens_in_context_window >= 0
        ? Math.floor(item.estimated_tokens_in_context_window)
        : undefined;
    const estimatedTokensCompactable =
      typeof item.estimated_tokens_compactable === 'number'
      && Number.isFinite(item.estimated_tokens_compactable)
      && item.estimated_tokens_compactable >= 0
        ? Math.floor(item.estimated_tokens_compactable)
        : undefined;
    const contextUsagePercent =
      typeof item.context_usage_percent === 'number'
      && Number.isFinite(item.context_usage_percent)
      && item.context_usage_percent >= 0
        ? Math.floor(item.context_usage_percent)
        : undefined;
    const maxInputTokens =
      typeof item.max_input_tokens === 'number' && Number.isFinite(item.max_input_tokens) && item.max_input_tokens >= 0
        ? Math.floor(item.max_input_tokens)
        : undefined;
    const thresholdPercent =
      typeof item.threshold_percent === 'number'
      && Number.isFinite(item.threshold_percent)
      && item.threshold_percent >= 0
        ? Math.floor(item.threshold_percent)
        : undefined;
    const seq =
      typeof item.seq === 'number' && Number.isFinite(item.seq) && item.seq >= 0
        ? Math.floor(item.seq)
        : undefined;
    result.push({
      ...(seq !== undefined ? { seq } : {}),
      round,
      ...(functionCallsCount !== undefined ? { functionCallsCount } : {}),
      ...(reasoningCount !== undefined ? { reasoningCount } : {}),
      ...(historyItemsCount !== undefined ? { historyItemsCount } : {}),
      ...(hasOutputText !== undefined ? { hasOutputText } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(responseStatus ? { responseStatus } : {}),
      ...(responseIncompleteReason ? { responseIncompleteReason } : {}),
      ...(responseId ? { responseId } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(estimatedTokensInContextWindow !== undefined ? { estimatedTokensInContextWindow } : {}),
      ...(estimatedTokensCompactable !== undefined ? { estimatedTokensCompactable } : {}),
      ...(contextUsagePercent !== undefined ? { contextUsagePercent } : {}),
      ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
      ...(thresholdPercent !== undefined ? { thresholdPercent } : {}),
    });
  }
  return result;
}

function extractKernelReasoningTrace(metadata: Record<string, unknown>): string[] {
  const raw = metadata.reasoning_trace;
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim().length > 0) {
      result.push(item.trim());
    }
  }
  return result;
}
function resolveStopReasonFromKernelMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata) return 'model_stop';
  const rounds = extractKernelRoundTrace(metadata);
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : undefined;
  if (lastRound?.finishReason && lastRound.finishReason.length > 0) return lastRound.finishReason;
  if (lastRound?.responseStatus && lastRound.responseStatus !== 'completed') {
    return `response_${lastRound.responseStatus}`;
  }
  return 'model_stop';
}

function normalizeRunnerSessionId(sessionId: string | undefined): string {
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : 'default';
}

function resolveRunnerRuntimeKey(sessionId: string | undefined): string {
  return normalizeRunnerSessionId(sessionId);
}

function resolveRunnerProviderId(context?: ChatCodexRunContext): string {
  const metadata = context?.metadata;
  if (isRecord(metadata)) {
    const fromKernelProviderId = parseOptionalString(metadata.kernelProviderId);
    if (fromKernelProviderId) return fromKernelProviderId;
    const fromProviderId = parseOptionalString(metadata.providerId);
    if (fromProviderId) return fromProviderId;
    const fromProvider = parseOptionalString(metadata.provider);
    if (fromProvider) return fromProvider;
  }
  const fromSettings = resolveActiveProviderIdFromUserSettings();
  if (fromSettings) return fromSettings;
  const fromEnv = parseOptionalString(process.env.FINGER_KERNEL_PROVIDER);
  if (fromEnv) return fromEnv;
  return '';
}

function resolveActiveProviderIdFromUserSettings(): string | undefined {
  try {
    const aiProviders = loadAIProviders();
    const normalized = typeof aiProviders.default === 'string' ? aiProviders.default.trim() : '';
    if (normalized.length > 0) return normalized;
    const first = Object.keys(aiProviders.providers || {})[0];
    return typeof first === 'string' && first.trim().length > 0 ? first.trim() : undefined;
  } catch {
    return undefined;
  }
}

 function resolveKernelBinaryPath(configuredPath?: string): string {
   if (configuredPath && configuredPath.length > 0) return configuredPath;
   if (process.env.FINGER_KERNEL_BRIDGE_BIN && process.env.FINGER_KERNEL_BRIDGE_BIN.length > 0) {
     return process.env.FINGER_KERNEL_BRIDGE_BIN;
   }
   // Check dist/bin first (global installation), then rust/target (local development)
  const distBinPath = join(FINGER_SOURCE_ROOT, 'dist', 'bin', 'finger-kernel-bridge-bin');
  if (existsSync(distBinPath)) return distBinPath;
   const releasePath = join(FINGER_SOURCE_ROOT, 'rust', 'target', 'release', 'finger-kernel-bridge-bin');
   const debugPath = join(FINGER_SOURCE_ROOT, 'rust', 'target', 'debug', 'finger-kernel-bridge-bin');
   if (existsSync(releasePath)) return releasePath;
   return debugPath;
 }

function parseKernelInputItems(metadata?: Record<string, unknown>): KernelInputItem[] | undefined {
  if (!metadata) return undefined;
  const raw = metadata.inputItems;
  if (!Array.isArray(raw)) return undefined;

  const parsed: KernelInputItem[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.type !== 'string') continue;

    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
      parsed.push({ type: 'text', text: item.text });
      continue;
    }

    if (item.type === 'image' && typeof item.image_url === 'string' && item.image_url.trim().length > 0) {
      parsed.push({ type: 'image', image_url: item.image_url });
      continue;
    }

    if (item.type === 'local_image' && typeof item.path === 'string' && item.path.trim().length > 0) {
      parsed.push({ type: 'local_image', path: item.path });
    }
  }

  return parsed.length > 0 ? parsed : undefined;
}

function normalizeKernelInputItems(items: KernelInputItem[] | undefined, fallbackText: string): KernelInputItem[] {
  const normalizedText = fallbackText.trim();
  const hasTextInItems = Array.isArray(items)
    && items.some((item) => item.type === 'text' && item.text.trim().length > 0);
  const merged: KernelInputItem[] = [];
  if (normalizedText.length > 0 && !hasTextInItems) {
    merged.push({ type: 'text', text: fallbackText });
  }
  if (items && items.length > 0) {
    merged.push(...items);
  }
  if (merged.length > 0) return merged;
  return [{ type: 'text', text: fallbackText }];
}

function buildKernelUserTurnOptions(
  context: ChatCodexRunContext | undefined,
  defaultToolExecution: ChatCodexToolExecutionConfig | undefined,
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>,
): KernelUserTurnOptions | undefined {
  const options: KernelUserTurnOptions = {};
  const metadata = context?.metadata;

  // Only treat heartbeat/bootstrap control injections as system-control turns.
  // Regular user turns handled by system agent must keep normal history path.
  const isSystemRole = isSystemControlTurn(metadata);

  if (context?.systemPrompt && context.systemPrompt.trim().length > 0) {
    options.system_prompt = context.systemPrompt.trim();
  }

  if (context?.sessionId && context.sessionId.trim().length > 0) {
    options.session_id = context.sessionId.trim();
  }

  const mode = parseOptionalString(metadata?.kernelMode) ?? parseOptionalString(metadata?.mode) ?? 'main';
  options.mode = mode;

  // For system role, skip history to avoid contamination
  const historyItems = isSystemRole
    ? []
    : resolveHistoryItems(context?.history, metadata);

  if (historyItems.length > 0) {
    options.history_items = historyItems;
  }

  const role = resolveDeveloperRoleFromMetadata(metadata);
  const availableToolNames = Array.isArray(context?.tools)
    ? context.tools
      .map((tool) => (tool && typeof tool.name === 'string' ? tool.name.trim() : ''))
      .filter((name) => name.length > 0)
    : undefined;
  let developerInstructions = resolveDeveloperInstructions(
    metadata,
    developerPromptPaths,
    role,
    context?.history,
    availableToolNames,
  );
  const skillsPromptBlock = buildSkillsPromptBlock(metadata);
  const mailboxBaselineBlock = buildMailboxBaselineBlock(context?.mailboxSnapshot, metadata);
  const userProfilePromptBlock = buildUserProfilePromptBlock(metadata);
  const memoryRoutingPromptBlock = buildMemoryRetrievalPromptBlock(metadata);
  const flowPromptBlock = buildFlowPromptBlock(metadata);
  const agentsScopePromptBlock = buildProjectAgentsScopePromptBlock(metadata);

  if (isSystemRole) {
    options.system_prompt = appendPromptSection(options.system_prompt, skillsPromptBlock);
    options.system_prompt = appendPromptSection(options.system_prompt, mailboxBaselineBlock);
    options.system_prompt = appendPromptSection(options.system_prompt, userProfilePromptBlock);
    options.system_prompt = appendPromptSection(options.system_prompt, memoryRoutingPromptBlock);
    options.system_prompt = appendPromptSection(options.system_prompt, flowPromptBlock);
    options.system_prompt = appendPromptSection(options.system_prompt, agentsScopePromptBlock);
  } else {
    developerInstructions = appendPromptSection(developerInstructions, skillsPromptBlock);
    developerInstructions = appendPromptSection(developerInstructions, mailboxBaselineBlock);
    developerInstructions = appendPromptSection(developerInstructions, userProfilePromptBlock);
    developerInstructions = appendPromptSection(developerInstructions, memoryRoutingPromptBlock);
    developerInstructions = appendPromptSection(developerInstructions, flowPromptBlock);
    developerInstructions = appendPromptSection(developerInstructions, agentsScopePromptBlock);
  }

  // Inject mailbox pending entries into context (works for all roles including system)
  if (context?.mailboxSnapshot && hasNewUnreadSinceLastNotified(context.mailboxSnapshot)) {
    const newEntries = getNewUnreadEntries(context.mailboxSnapshot);
    const mailboxBlock = [
      '# Mailbox',
      `pending=${newEntries.length}`,
      ...newEntries.map((entry) => `- ${entry.shortDescription}`),
    ].join('\n');

    if (isSystemRole) {
      // For system role, append mailbox to system prompt
      options.system_prompt = appendPromptSection(options.system_prompt, mailboxBlock);
    } else {
      // For other roles, append to developer instructions
      developerInstructions = appendPromptSection(developerInstructions, mailboxBlock);
    }
  }

  // Add developer instructions (role-specific prompt) for all roles
  if (developerInstructions) {
    options.developer_instructions = developerInstructions;
  }

  const userInstructions = resolveUserInstructions(metadata);
  if (userInstructions) {
    options.user_instructions = userInstructions;
  }

  const turnContext = resolveTurnContext(metadata);
  if (turnContext) {
    options.turn_context = turnContext;
  }

  const environmentContext = resolveEnvironmentContext(metadata, turnContext);
  if (environmentContext) {
    options.environment_context = environmentContext;
  }

  const contextWindow = resolveContextWindow(metadata);
  if (contextWindow) {
    options.context_window = contextWindow;
  }

  const compact = resolveCompactConfig(metadata);
  if (compact) {
    options.compact = compact;
  }

  const forkUserMessageIndex = resolveForkUserMessageIndex(metadata);
  if (typeof forkUserMessageIndex === 'number') {
    options.fork_user_message_index = forkUserMessageIndex;
  }

  const contextLedger = resolveContextLedger(metadata, context?.sessionId);
  if (contextLedger) {
    options.context_ledger = contextLedger;
  }

  const responses = resolveResponsesOptions(metadata, role);
  if (responses) {
    options.responses = responses;
  }

  if (context?.tools && context.tools.length > 0) {
    options.tools = context.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description && tool.description.trim().length > 0 ? { description: tool.description.trim() } : {}),
      ...(tool.inputSchema ? { input_schema: tool.inputSchema } : {}),
    }));
  }

  const toolExecution = context?.toolExecution ?? defaultToolExecution;
  if (toolExecution && toolExecution.daemonUrl.trim().length > 0 && toolExecution.agentId.trim().length > 0) {
    options.tool_execution = {
      daemon_url: toolExecution.daemonUrl.trim(),
      agent_id: toolExecution.agentId.trim(),
      ...(context?.sessionId && context.sessionId.trim().length > 0 ? { session_id: context.sessionId.trim() } : {}),
    };
  }

  if (
    !options.system_prompt &&
    !options.session_id &&
    !options.mode &&
    !options.history_items &&
    !options.developer_instructions &&
    !options.user_instructions &&
    !options.environment_context &&
    !options.turn_context &&
    !options.context_window &&
    !options.compact &&
    !options.fork_user_message_index &&
    !options.context_ledger &&
    !options.responses &&
    !options.tools &&
    !options.tool_execution
  ) {
    return undefined;
  }

  return options;
}

function hydratePrebuiltKernelUserTurnOptions(
  prebuilt: KernelUserTurnOptions,
  context: ChatCodexRunContext | undefined,
  defaultToolExecution: ChatCodexToolExecutionConfig | undefined,
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>,
): KernelUserTurnOptions {
  const rebuilt = buildKernelUserTurnOptions(context, defaultToolExecution, developerPromptPaths) ?? {};
  const merged: KernelUserTurnOptions = {
    ...rebuilt,
    ...prebuilt,
  };

  if ((!Array.isArray(prebuilt.history_items) || prebuilt.history_items.length === 0) && Array.isArray(rebuilt.history_items) && rebuilt.history_items.length > 0) {
    merged.history_items = rebuilt.history_items;
  }

  if ((!Array.isArray(prebuilt.tools) || prebuilt.tools.length === 0) && Array.isArray(rebuilt.tools) && rebuilt.tools.length > 0) {
    merged.tools = rebuilt.tools;
  }

  if ((!isRecord(prebuilt.tool_execution) || Object.keys(prebuilt.tool_execution).length === 0) && isRecord(rebuilt.tool_execution)) {
    merged.tool_execution = rebuilt.tool_execution;
  }

  if ((!isRecord(prebuilt.context_ledger) || Object.keys(prebuilt.context_ledger).length === 0) && isRecord(rebuilt.context_ledger)) {
    merged.context_ledger = rebuilt.context_ledger;
  }

  if ((!isRecord(prebuilt.responses) || Object.keys(prebuilt.responses).length === 0) && isRecord(rebuilt.responses)) {
    merged.responses = rebuilt.responses;
  }

  if (typeof prebuilt.system_prompt !== 'string' && typeof rebuilt.system_prompt === 'string') {
    merged.system_prompt = rebuilt.system_prompt;
  }

  if (typeof prebuilt.session_id !== 'string' && typeof rebuilt.session_id === 'string') {
    merged.session_id = rebuilt.session_id;
  }

  if (typeof prebuilt.mode !== 'string' && typeof rebuilt.mode === 'string') {
    merged.mode = rebuilt.mode;
  }

  if (typeof prebuilt.developer_instructions !== 'string' && typeof rebuilt.developer_instructions === 'string') {
    merged.developer_instructions = rebuilt.developer_instructions;
  }

  if (typeof prebuilt.user_instructions !== 'string' && typeof rebuilt.user_instructions === 'string') {
    merged.user_instructions = rebuilt.user_instructions;
  }

  if (typeof prebuilt.environment_context !== 'string' && typeof rebuilt.environment_context === 'string') {
    merged.environment_context = rebuilt.environment_context;
  }

  if (!isRecord(prebuilt.turn_context) && isRecord(rebuilt.turn_context)) {
    merged.turn_context = rebuilt.turn_context;
  }

  if (!isRecord(prebuilt.context_window) && isRecord(rebuilt.context_window)) {
    merged.context_window = rebuilt.context_window;
  }

  if (!isRecord(prebuilt.compact) && isRecord(rebuilt.compact)) {
    merged.compact = rebuilt.compact;
  }

  if (typeof prebuilt.fork_user_message_index !== 'number' && typeof rebuilt.fork_user_message_index === 'number') {
    merged.fork_user_message_index = rebuilt.fork_user_message_index;
  }

  return merged;
}

function isSystemControlTurn(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  if (parseOptionalBoolean(metadata.recoveryReplay) === true) {
    return false;
  }
  const explicitDirect = parseOptionalBoolean(metadata.systemDirectInject);
  if (explicitDirect === true) return true;

  const source = (parseOptionalString(metadata.source) ?? '').toLowerCase();
  if (source.includes('heartbeat') || source.includes('bootstrap')) return true;

  return false;
}

function appendPromptSection(base: string | undefined, section: string | undefined): string | undefined {
  const normalizedSection = section?.trim();
  if (!normalizedSection) return base;
  if (!base || base.trim().length === 0) return normalizedSection;
  if (base.includes(normalizedSection)) return base;
  return `${base}\n\n${normalizedSection}`;
}

function buildSkillsPromptBlock(metadata: Record<string, unknown> | undefined): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.skillsPromptEnabled)
    ?? parseOptionalBoolean(metadata?.skillsInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;
  const projectPath = parseOptionalString(metadata?.projectPath) ?? parseOptionalString(metadata?.project_path);
  const cwd = parseOptionalString(metadata?.cwd);
  const includeProjectSkills = isProjectLikeAgent(metadata);
  const block = formatSkillsAsPromptScopedSync({
    includeProjectSkills,
    projectPath,
    cwd,
  }).trim();
  return block.length > 0 ? block : undefined;
}

function isProjectLikeAgent(metadata: Record<string, unknown> | undefined): boolean {
  const role = (parseOptionalString(metadata?.roleProfile)
    ?? parseOptionalString(metadata?.role_profile)
    ?? parseOptionalString(metadata?.contextLedgerRole)
    ?? parseOptionalString(metadata?.context_ledger_role)
    ?? parseOptionalString(metadata?.role)
    ?? '').trim().toLowerCase();
  if (role === 'project') return true;

  const agentId = (parseOptionalString(metadata?.contextLedgerAgentId)
    ?? parseOptionalString(metadata?.context_ledger_agent_id)
    ?? parseOptionalString(metadata?.agentId)
    ?? parseOptionalString(metadata?.agent_id)
    ?? '').trim().toLowerCase();
  return agentId.includes('project-agent');
}

function normalizeAbsoluteDir(rawPath: string | undefined): string | undefined {
  if (typeof rawPath !== 'string') return undefined;
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  return resolve(trimmed);
}

function isSameOrSubPath(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function collectApplicableAgentsFiles(startDir: string, projectRoot?: string): string[] {
  const files: string[] = [];
  const addIfExists = (dir: string): void => {
    const upper = join(dir, 'AGENTS.md');
    const lower = join(dir, 'agents.md');
    if (existsSync(upper)) {
      files.push(upper);
      return;
    }
    if (existsSync(lower)) files.push(lower);
  };

  const normalizedProjectRoot = projectRoot ? resolve(projectRoot) : undefined;
  let cursor = resolve(startDir);
  while (true) {
    addIfExists(cursor);
    if (normalizedProjectRoot && cursor === normalizedProjectRoot) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  if (normalizedProjectRoot) {
    addIfExists(normalizedProjectRoot);
  }

  return Array.from(new Set(files));
}

function buildProjectAgentsScopePromptBlock(metadata: Record<string, unknown> | undefined): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.agentsPromptEnabled)
    ?? parseOptionalBoolean(metadata?.agentsInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;
  if (!isProjectLikeAgent(metadata)) return undefined;

  const projectPath = normalizeAbsoluteDir(parseOptionalString(metadata?.projectPath) ?? parseOptionalString(metadata?.project_path));
  const cwd = normalizeAbsoluteDir(parseOptionalString(metadata?.cwd)) ?? projectPath;
  if (!cwd && !projectPath) return undefined;

  const startDir = cwd ?? projectPath!;
  const boundedProjectRoot = projectPath && isSameOrSubPath(startDir, projectPath)
    ? projectPath
    : undefined;
  const applicableFiles = collectApplicableAgentsFiles(startDir, boundedProjectRoot);
  const orderedByPrecedence = applicableFiles.slice().reverse();

  const lines: string[] = [
    '# Project AGENTS Runtime (scope-aware)',
    '- This is a project-agent turn: apply directory-scoped AGENTS rules.',
    '- Scope rule: each AGENTS.md applies to its directory subtree.',
    '- Precedence rule: deeper/nested AGENTS overrides parent AGENTS on conflicts.',
    '- Priority rule: system/developer/user instructions override AGENTS.',
    `AGENTS.cwd=${startDir}`,
    `AGENTS.project_root=${projectPath ?? '(unset)'}`,
    `AGENTS.applicable_count=${orderedByPrecedence.length}`,
  ];

  if (orderedByPrecedence.length === 0) {
    lines.push('AGENTS.state=none_found');
    return lines.join('\n');
  }

  lines.push('AGENTS.precedence_order(low->high):');
  orderedByPrecedence.forEach((filePath, index) => {
    lines.push(`${index + 1}. ${filePath}`);
  });

  const fileContents = applicableFiles.slice(0, AGENTS_PROMPT_MAX_FILES);
  for (const filePath of fileContents) {
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      const rendered = raw.length > AGENTS_PROMPT_MAX_CHARS_PER_FILE
        ? `${raw.slice(0, AGENTS_PROMPT_MAX_CHARS_PER_FILE)}\n...[TRUNCATED_AT_${AGENTS_PROMPT_MAX_CHARS_PER_FILE}_CHARS]`
        : raw;
      lines.push(`AGENTS.content[${filePath}]:`);
      lines.push('```md');
      lines.push(rendered);
      lines.push('```');
    } catch {
      lines.push(`AGENTS.content[${filePath}]=unreadable`);
    }
  }

  if (applicableFiles.length > AGENTS_PROMPT_MAX_FILES) {
    lines.push(`AGENTS.content.truncated=true (${applicableFiles.length - AGENTS_PROMPT_MAX_FILES} more files omitted)`);
  }

  return lines.join('\n');
}

function buildMailboxBaselineBlock(
  snapshot: MailboxSnapshot | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.mailboxPromptEnabled)
    ?? parseOptionalBoolean(metadata?.mailboxInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;

  const lines = [
    '# Mailbox Runtime',
    'Use mailbox tools for async task and notification handling.',
    '- Tools: mailbox.status / mailbox.list / mailbox.read / mailbox.read_all / mailbox.ack / mailbox.remove / mailbox.remove_all',
    '- For low-priority notifications, title + short description may be enough; you can ack/remove directly when no further action is required.',
  ];
  if (snapshot) {
    const unread = Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
    lines.push(`snapshot.currentSeq=${snapshot.currentSeq}`);
    lines.push(`snapshot.unread=${unread}`);
  }
  return lines.join('\n');
}

function buildUserProfilePromptBlock(metadata: Record<string, unknown> | undefined): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.userProfilePromptEnabled)
    ?? parseOptionalBoolean(metadata?.userProfileInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;

  const explicitPath = parseOptionalString(metadata?.userProfileFilePath)
    ?? parseOptionalString(metadata?.user_profile_file_path)
    ?? parseOptionalString(metadata?.userProfilePath)
    ?? parseOptionalString(metadata?.user_profile_path);
  const profilePath = explicitPath && explicitPath.trim().length > 0
    ? explicitPath.trim()
    : join(FINGER_PATHS.home, 'USER.md');

  let profileContent = '';
  if (existsSync(profilePath)) {
    try {
      profileContent = readFileSync(profilePath, 'utf-8').trim();
    } catch {
      profileContent = '';
    }
  }

  const lines = [
    '# User Profile Runtime (USER.md)',
    `USER.path=${profilePath}`,
    '- USER.md is injected as runtime profile context for this turn; follow it strictly.',
    '- If user gives repeated corrections / strong negative feedback, update USER.md immediately (append-only, evidence-based).',
  ];

  if (profileContent.length === 0) {
    lines.push('USER.state=empty');
    return lines.join('\n');
  }

  const rendered = profileContent.length > USER_PROFILE_PROMPT_MAX_CHARS
    ? `${profileContent.slice(0, USER_PROFILE_PROMPT_MAX_CHARS)}\n...[TRUNCATED_AT_8000_CHARS]`
    : profileContent;
  lines.push('USER.content.begin');
  lines.push(rendered);
  lines.push('USER.content.end');
  return lines.join('\n');
}

function buildMemoryRetrievalPromptBlock(metadata: Record<string, unknown> | undefined): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.memoryRoutingPromptEnabled)
    ?? parseOptionalBoolean(metadata?.memoryRoutingInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;
  return [
    '# Memory Retrieval Routing (mandatory)',
    '- Long-term durable facts/constraints: read MEMORY.md.',
    '- Timeline/history/tool traces: use context_ledger.memory (search -> query detail=true with slot_start/slot_end).',
    '- Need full details from a compact digest/task block: use context_ledger.expand_task.',
    '- Need broader relevant history in prompt: use context_builder.rebuild (P4 dynamic_history only).',
    '- Do not treat visible prompt history as complete truth when historical evidence is required.',
  ].join('\n');
}

function buildFlowPromptBlock(metadata: Record<string, unknown> | undefined): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.flowPromptEnabled)
    ?? parseOptionalBoolean(metadata?.flowInjectionEnabled)
    ?? true;
  if (!enabled) return undefined;

  const resolveGlobalFlowPath = (): string => {
    const explicitGlobal = parseOptionalString(metadata?.globalFlowFilePath)
      ?? parseOptionalString(metadata?.global_flow_file_path);
    if (explicitGlobal) return explicitGlobal;
    return join(FINGER_PATHS.home, 'FLOW.md');
  };

  const resolveLocalFlowPath = (): string => {
    const explicitLocal = parseOptionalString(metadata?.flowFilePath) ?? parseOptionalString(metadata?.flow_file_path);
    if (explicitLocal) return explicitLocal;

    const projectPath = parseOptionalString(metadata?.projectPath) ?? parseOptionalString(metadata?.project_path);
    if (projectPath) return join(projectPath, 'FLOW.md');

    const agentId = parseOptionalString(metadata?.contextLedgerAgentId)
      ?? parseOptionalString(metadata?.agentId)
      ?? parseOptionalString(metadata?.agent_id);
    if (agentId === 'finger-system-agent') {
      return join(FINGER_PATHS.home, 'system', 'FLOW.md');
    }

    const cwd = parseOptionalString(metadata?.cwd);
    if (cwd) return join(cwd, 'FLOW.md');

    return join(process.cwd(), 'FLOW.md');
  };

  const readFlowContent = (flowPath: string): string | undefined => {
    if (!flowPath || !existsSync(flowPath)) return undefined;
    try {
      const content = readFileSync(flowPath, 'utf-8');
      return content.length > 0 ? content : undefined;
    } catch {
      return undefined;
    }
  };

  const renderTruncatedFlow = (raw: string | undefined): string | undefined => {
    if (!raw || raw.trim().length === 0) return undefined;
    return raw.length > FLOW_PROMPT_MAX_CHARS
      ? `${raw.slice(0, FLOW_PROMPT_MAX_CHARS)}\n...[TRUNCATED_AT_10000_CHARS]`
      : raw;
  };

  const globalFlowPath = resolveGlobalFlowPath();
  const localFlowPath = resolveLocalFlowPath();
  const globalFlow = renderTruncatedFlow(readFlowContent(globalFlowPath));
  const localFlow = renderTruncatedFlow(readFlowContent(localFlowPath));

  const lines = [
    '# Task Flow Runtime',
    '- Flow context uses two layers: Global FLOW + Local FLOW.',
    '- Load order is fixed: Global first, Local second.',
    '- Conflict rule: Local FLOW has higher priority than Global FLOW.',
    '- Each FLOW file has strict 10,000-char truncation in prompt (hard cap).',
    '- Mode split is mandatory: Development mode vs Debug mode.',
    '- Development mode: propose a comprehensive implementation plan, ask user confirmation once, then write/update FLOW.md and execute by flow state-machine progression.',
    '- Debug mode: reproduce/validate issue -> root-cause analysis -> compare options -> choose the best root fix -> implement directly (no redundant confirmation before fix).',
    '- In debug mode, only ask before fix when action is dangerous, irreversible, permission-gated, or materially ambiguous.',
    '- Root-fix quality bar: prefer rigorous root-cause solutions; avoid workaround-only/patch-around fixes unless explicitly requested.',
    '- Simple tasks (e.g. quick search/read/single-step lookup) can execute directly without creating a flow.',
    '- If new sub-flow appears during current task, update FLOW.md to reflect latest plan/state.',
    '- Cleanup rule: only after user explicitly confirms task completion, reset FLOW.md content to avoid contaminating next task.',
    '- Do not clear FLOW.md before explicit user completion confirmation.',
    `FLOW.global.path=${globalFlowPath}`,
    `FLOW.local.path=${localFlowPath}`,
  ];

  if (!globalFlow && !localFlow) {
    lines.push('FLOW.state=empty(global+local)');
    return lines.join('\n');
  }

  lines.push('FLOW.content.global:');
  if (globalFlow) {
    lines.push('```md');
    lines.push(globalFlow);
    lines.push('```');
  } else {
    lines.push('(empty)');
  }

  lines.push('FLOW.content.local:');
  if (localFlow) {
    lines.push('```md');
    lines.push(localFlow);
    lines.push('```');
  } else {
    lines.push('(empty)');
  }

  return lines.join('\n');
}

function resolveResponsesOptions(
  metadata: Record<string, unknown> | undefined,
  role: ChatCodexDeveloperRole,
): KernelUserTurnOptions['responses'] | undefined {
  const reasoningEnabled = parseOptionalBoolean(metadata?.responsesReasoningEnabled) ?? true;
  const reasoningEffort = parseOptionalString(metadata?.responsesReasoningEffort) ?? 'medium';
  const reasoningSummary = parseOptionalString(metadata?.responsesReasoningSummary) ?? 'detailed';
  const includeEncryptedContent = parseOptionalBoolean(metadata?.responsesIncludeEncryptedReasoning) ?? true;

  const textEnabled = parseOptionalBoolean(metadata?.responsesTextEnabled) ?? true;
  const textVerbosity = parseOptionalString(metadata?.responsesTextVerbosity) ?? 'medium';
  const outputSchema = resolveResponsesOutputSchema(metadata, role);

  const include = Array.isArray(metadata?.responsesInclude)
    ? metadata.responsesInclude
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];
  const store = parseOptionalBoolean(metadata?.responsesStore);
  const parallelToolCalls = parseOptionalBoolean(metadata?.responsesParallelToolCalls) ?? true;

  return {
    reasoning: {
      enabled: reasoningEnabled,
      effort: reasoningEffort,
      summary: reasoningSummary,
      include_encrypted_content: includeEncryptedContent,
    },
    text: {
      enabled: textEnabled,
      verbosity: textVerbosity,
      ...(outputSchema ? { output_schema: outputSchema } : {}),
    },
    ...(include.length > 0 ? { include } : {}),
    ...(store !== undefined ? { store } : {}),
    parallel_tool_calls: parallelToolCalls,
  };
}

function estimateTextTokens(text: string | undefined): number {
  if (typeof text !== 'string') return 0;
  const normalized = text.trim();
  if (!normalized) return 0;
  return estimateTokensWithTiktoken(normalized);
}

function estimateHistoryItemsTokens(items: Array<Record<string, unknown>> | undefined): number {
  if (!Array.isArray(items) || items.length === 0) return 0;
  let total = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const role = typeof item.role === 'string' ? item.role : '';
    const content = Array.isArray(item.content) ? item.content : [];
    const contentText = content
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => {
        if (typeof entry.text === 'string') return entry.text;
        if (typeof entry.image_url === 'string') return `[image] ${entry.image_url}`;
        if (typeof entry.path === 'string') return `[local_image] ${entry.path}`;
        return '';
      })
      .filter((entry) => entry.length > 0)
      .join('\n');
    total += estimateTokensWithTiktoken(`${role}\n${contentText}`);
  }
  return total;
}

function estimateTaskContextSlotTokensFromMetadata(metadata: Record<string, unknown> | undefined): number {
  if (!metadata || !Array.isArray(metadata.contextSlots)) return 0;
  let total = 0;
  for (const item of metadata.contextSlots) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id.startsWith('task.')) continue;
    const content = typeof item.content === 'string' ? item.content : '';
    total += estimateTextTokens(content);
  }
  return total;
}

function estimateTaskContextSlotTokensFromRendered(rendered: string | undefined): number {
  if (typeof rendered !== 'string' || rendered.trim().length === 0) return 0;
  const pattern = /<slot id="(task\.[^"]+)">\n([\s\S]*?)\n<\/slot>/g;
  let match: RegExpExecArray | null = pattern.exec(rendered);
  let total = 0;
  while (match) {
    total += estimateTextTokens(match[2]);
    match = pattern.exec(rendered);
  }
  return total;
}

function estimateStructuredTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return estimateTokensWithTiktoken(JSON.stringify(value));
  } catch {
    return estimateTextTokens(String(value));
  }
}

function estimateInputItemsBreakdown(
  inputItems: KernelInputItem[] | undefined,
  fallbackUserText?: string,
): { inputTextTokens: number; inputMediaTokens: number; inputMediaCount: number; inputTotalTokens: number } {
  if (!Array.isArray(inputItems) || inputItems.length === 0) {
    const fallback = estimateTextTokens(fallbackUserText);
    return { inputTextTokens: fallback, inputMediaTokens: 0, inputMediaCount: 0, inputTotalTokens: fallback };
  }

  let inputTextTokens = 0;
  let inputMediaTokens = 0;
  let inputMediaCount = 0;
  for (const item of inputItems) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') {
      inputTextTokens += estimateTextTokens(item.text);
      continue;
    }
    if (item.type === 'image') {
      inputMediaCount += 1;
      continue;
    }
    if (item.type === 'local_image') {
      inputMediaCount += 1;
    }
  }

  // Media attachments are not counted into model context token budget in our policy.
  inputMediaTokens = 0;
  const inputTotalTokens = inputTextTokens + inputMediaTokens;
  return { inputTextTokens, inputMediaTokens, inputMediaCount, inputTotalTokens };
}

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function resolveContextBreakdownSnapshot(params: {
  options?: KernelUserTurnOptions;
  metadata?: Record<string, unknown>;
  mailboxSnapshot?: MailboxSnapshot;
  inputItems?: KernelInputItem[];
  userText?: string;
}): ContextBreakdownSnapshot | undefined {
  const metadata = params.metadata;
  const options = params.options;
  const historyItems = Array.isArray(options?.history_items) ? options?.history_items : [];
  const historyTotalTokens = estimateHistoryItemsTokens(historyItems);
  const metadataHistoryContextTokens =
    parseOptionalNonNegativeNumber(metadata?.historyContextTokens)
    ?? parseOptionalNonNegativeNumber(metadata?.history_context_tokens);
  const metadataHistoryCurrentTokens =
    parseOptionalNonNegativeNumber(metadata?.historyCurrentTokens)
    ?? parseOptionalNonNegativeNumber(metadata?.history_current_tokens);
  const metadataHistoryContextMessages =
    parseOptionalNonNegativeNumber(metadata?.historyContextMessages)
    ?? parseOptionalNonNegativeNumber(metadata?.history_context_messages);
  const metadataHistoryCurrentMessages =
    parseOptionalNonNegativeNumber(metadata?.historyCurrentMessages)
    ?? parseOptionalNonNegativeNumber(metadata?.history_current_messages);
  const historyContextTokens = metadataHistoryContextTokens !== undefined
    ? Math.max(0, Math.floor(metadataHistoryContextTokens))
    : undefined;
  const historyCurrentTokens = metadataHistoryCurrentTokens !== undefined
    ? Math.max(0, Math.floor(metadataHistoryCurrentTokens))
    : historyContextTokens !== undefined
      ? Math.max(0, historyTotalTokens - historyContextTokens)
      : historyTotalTokens;
  const skillsBlock = buildSkillsPromptBlock(metadata);
  const mailboxBaselineBlock = buildMailboxBaselineBlock(params.mailboxSnapshot, metadata);
  const unreadEntries = params.mailboxSnapshot && hasNewUnreadSinceLastNotified(params.mailboxSnapshot)
    ? getNewUnreadEntries(params.mailboxSnapshot)
    : [];
  const mailboxUnreadBlock = unreadEntries.length > 0
    ? [
        '# Mailbox',
        `pending=${unreadEntries.length}`,
        ...unreadEntries.map((entry) => `- ${entry.shortDescription}`),
      ].join('\n')
    : undefined;
  const flowBlock = buildFlowPromptBlock(metadata);
  const contextSlotsRendered = parseOptionalString(metadata?.contextSlotsRendered)
    ?? parseOptionalString(metadata?.context_slots_rendered);

  const systemPromptTokens = estimateTextTokens(options?.system_prompt);
  const developerPromptTokens = estimateTextTokens(options?.developer_instructions);
  const userInstructionsTokens = estimateTextTokens(options?.user_instructions);
  const environmentContextTokens = estimateTextTokens(options?.environment_context);
  const turnContextTokens = estimateStructuredTokens(options?.turn_context);
  const skillsTokens = estimateTextTokens(skillsBlock);
  const mailboxTokens = estimateTextTokens(mailboxBaselineBlock) + estimateTextTokens(mailboxUnreadBlock);
  const flowTokens = estimateTextTokens(flowBlock);
  const contextSlotsTokens = estimateTextTokens(contextSlotsRendered);
  const projectTokensFromMetadata = estimateTaskContextSlotTokensFromMetadata(metadata);
  const projectTokensFromRendered = estimateTaskContextSlotTokensFromRendered(contextSlotsRendered);
  const projectTokens = Math.max(projectTokensFromMetadata, projectTokensFromRendered);
  const { inputTextTokens, inputMediaTokens, inputMediaCount, inputTotalTokens } = estimateInputItemsBreakdown(
    params.inputItems,
    params.userText,
  );
  const toolsSchemaTokens = estimateStructuredTokens(options?.tools);
  const toolExecutionTokens = estimateStructuredTokens(options?.tool_execution);
  const contextLedgerConfigTokens = estimateStructuredTokens(options?.context_ledger);
  const responsesConfigTokens = estimateStructuredTokens(options?.responses);
  const totalKnownTokens = historyTotalTokens
    + systemPromptTokens
    + developerPromptTokens
    + userInstructionsTokens
    + environmentContextTokens
    + turnContextTokens
    + skillsTokens
    + mailboxTokens
    + flowTokens
    + contextSlotsTokens
    + inputTotalTokens
    + toolsSchemaTokens
    + toolExecutionTokens
    + contextLedgerConfigTokens
    + responsesConfigTokens;

  if (
    historyTotalTokens <= 0
    && (historyContextTokens === undefined || historyContextTokens <= 0)
    && (historyCurrentTokens === undefined || historyCurrentTokens <= 0)
    && systemPromptTokens <= 0
    && developerPromptTokens <= 0
    && userInstructionsTokens <= 0
    && environmentContextTokens <= 0
    && turnContextTokens <= 0
    && skillsTokens <= 0
    && mailboxTokens <= 0
    && flowTokens <= 0
    && projectTokens <= 0
    && contextSlotsTokens <= 0
    && inputTotalTokens <= 0
    && toolsSchemaTokens <= 0
    && toolExecutionTokens <= 0
    && contextLedgerConfigTokens <= 0
    && responsesConfigTokens <= 0
  ) {
    return undefined;
  }

  return {
    ...(historyContextTokens !== undefined ? { historyContextTokens } : {}),
    ...(historyCurrentTokens !== undefined ? { historyCurrentTokens } : {}),
    ...(historyTotalTokens >= 0 ? { historyTotalTokens } : {}),
    ...(metadataHistoryContextMessages !== undefined
      ? { historyContextMessages: Math.max(0, Math.floor(metadataHistoryContextMessages)) }
      : {}),
    ...(metadataHistoryCurrentMessages !== undefined
      ? { historyCurrentMessages: Math.max(0, Math.floor(metadataHistoryCurrentMessages)) }
      : {}),
    ...(systemPromptTokens >= 0 ? { systemPromptTokens } : {}),
    ...(developerPromptTokens >= 0 ? { developerPromptTokens } : {}),
    ...(userInstructionsTokens >= 0 ? { userInstructionsTokens } : {}),
    ...(environmentContextTokens >= 0 ? { environmentContextTokens } : {}),
    ...(turnContextTokens >= 0 ? { turnContextTokens } : {}),
    ...(skillsTokens >= 0 ? { skillsTokens } : {}),
    ...(mailboxTokens >= 0 ? { mailboxTokens } : {}),
    ...(projectTokens >= 0 ? { projectTokens } : {}),
    ...(flowTokens >= 0 ? { flowTokens } : {}),
    ...(contextSlotsTokens >= 0 ? { contextSlotsTokens } : {}),
    ...(inputTextTokens >= 0 ? { inputTextTokens } : {}),
    ...(inputMediaTokens >= 0 ? { inputMediaTokens } : {}),
    ...(inputMediaCount >= 0 ? { inputMediaCount } : {}),
    ...(inputTotalTokens >= 0 ? { inputTotalTokens } : {}),
    ...(toolsSchemaTokens >= 0 ? { toolsSchemaTokens } : {}),
    ...(toolExecutionTokens >= 0 ? { toolExecutionTokens } : {}),
    ...(contextLedgerConfigTokens >= 0 ? { contextLedgerConfigTokens } : {}),
    ...(responsesConfigTokens >= 0 ? { responsesConfigTokens } : {}),
    ...(totalKnownTokens > 0 ? { totalKnownTokens } : {}),
    source: 'prompt_options+tiktoken',
  };
}

function resolveHistoryItems(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined,
  metadata: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  const hasMediaInput = hasMediaInputItemsInMetadata(metadata);
  const preferContextBuilderHistory = shouldPreferContextBuilderHistory(metadata);
  const fromMetadata = metadata?.kernelApiHistory;
  const normalizedFromMetadata = !hasMediaInput && Array.isArray(fromMetadata)
    ? fromMetadata.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  if (!preferContextBuilderHistory && normalizedFromMetadata.length > 0) {
    return normalizedFromMetadata;
  }

  if (!history || history.length === 0) {
    return normalizedFromMetadata;
  }

  const normalizedFromHistory = history
    .filter((item) => item.content.trim().length > 0)
    .map((item) => ({
      role: item.role === 'system' ? 'user' : item.role,
      content: [
        {
          type: item.role === 'assistant' ? 'output_text' : 'input_text',
          text: item.role === 'system' ? `<system_message>\n${item.content}\n</system_message>` : item.content,
        },
      ],
    }));

  if (normalizedFromHistory.length > 0) {
    return normalizedFromHistory;
  }

  if (normalizedFromMetadata.length > 0) {
    return normalizedFromMetadata;
  }

  return [];
}

function shouldPreferContextBuilderHistory(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const source = parseOptionalString(metadata.contextHistorySource)?.trim().toLowerCase() ?? '';
  if (source === 'raw_session' || source === 'raw_session_fallback') return true;
  if (source === 'session_view_passthrough' || source === 'session_view_fallback') return true;
  if (source.startsWith('context_builder')) return true;
  if (parseOptionalBoolean(metadata.contextBuilderIndexed) === true) return true;
  if (parseOptionalBoolean(metadata.contextBuilderRebuilt) === true) return true;
  if (parseOptionalBoolean(metadata.contextBuilderBypassed) === false) return true;
  return false;
}

function hasMediaInputItemsInMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const raw = metadata.inputItems;
  if (!Array.isArray(raw)) return false;
  return raw.some((item) => {
    if (!isRecord(item) || typeof item.type !== 'string') return false;
    return item.type === 'image' || item.type === 'local_image';
  });
}

function resolveDeveloperInstructions(
  metadata: Record<string, unknown> | undefined,
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>,
  resolvedRole?: ChatCodexDeveloperRole,
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
  availableToolNames?: string[],
): string | undefined {
  const explicit = parseOptionalString(metadata?.developerInstructions)
    ?? parseOptionalString(metadata?.developer_instructions);
  const collaborationMode = parseOptionalString(metadata?.collaborationMode)
    ?? parseOptionalString(metadata?.collaboration_mode);
  const modelSwitchHint = parseOptionalString(metadata?.modelSwitchHint)
    ?? parseOptionalString(metadata?.model_switch_hint);
  const role = resolvedRole ?? resolveDeveloperRoleFromMetadata(metadata);
  const rolePrompt = resolveDeveloperPromptTemplate(role, developerPromptPaths?.[role]);
  const ledgerBlock = buildLedgerDeveloperInstructions(metadata, role);
  const continuityBlock = buildContinuityDeveloperInstructions(history, metadata);
  const promptOptimizationBlock = buildPromptOptimizationDeveloperInstructions(
    metadata,
    role,
    availableToolNames,
  );
  const contextSlotsRendered = parseOptionalString(metadata?.contextSlotsRendered)
    ?? parseOptionalString(metadata?.context_slots_rendered);

  const hints: string[] = [];
  if (collaborationMode) hints.push(`collaboration_mode=${collaborationMode}`);
  if (modelSwitchHint) hints.push(`model_switch_hint=${modelSwitchHint}`);

  const sections = [
    rolePrompt,
    promptOptimizationBlock,
    ledgerBlock,
    continuityBlock,
    contextSlotsRendered,
    hints.join('\n'),
    explicit,
  ]
    .map((item) => item?.trim() ?? '')
    .filter((item) => item.length > 0);
  if (sections.length === 0) return undefined;

  const deduped: string[] = [];
  for (const section of sections) {
    if (!deduped.includes(section)) deduped.push(section);
  }
  return deduped.join('\n\n');
}

function buildPromptOptimizationDeveloperInstructions(
  metadata: Record<string, unknown> | undefined,
  role: ChatCodexDeveloperRole,
  availableToolNames?: string[],
): string | undefined {
  const enabled = parseOptionalBoolean(metadata?.promptOptimizationEnabled)
    ?? parseOptionalBoolean(metadata?.prompt_optimization_enabled)
    ?? true;
  if (!enabled) return undefined;

  const outputStyle = parseOutputStyle(metadata);
  const agentType = mapDeveloperRoleToPromptAgentType(role);
  const agentDefinition = getAgentDefinition(agentType);

  const source = parseOptionalString(metadata?.source)?.toLowerCase() ?? '';
  const mode = parseOptionalString(metadata?.kernelMode)
    ?? parseOptionalString(metadata?.mode)
    ?? 'main';
  const sessionType = source.includes('heartbeat') ? 'heartbeat' : mode;

  const featureFlags = {
    prompt_agent_definition: parseOptionalBoolean(metadata?.promptOptAgentDefinitionEnabled)
      ?? parseOptionalBoolean(metadata?.prompt_opt_agent_definition_enabled)
      ?? true,
    prompt_frc: parseOptionalBoolean(metadata?.promptOptFunctionResultClearingEnabled)
      ?? parseOptionalBoolean(metadata?.prompt_opt_function_result_clearing_enabled)
      ?? true,
    prompt_autonomous: parseOptionalBoolean(metadata?.promptOptAutonomousEnabled)
      ?? parseOptionalBoolean(metadata?.prompt_opt_autonomous_enabled)
      ?? true,
    prompt_output_style: parseOptionalBoolean(metadata?.promptOptOutputStyleEnabled)
      ?? parseOptionalBoolean(metadata?.prompt_opt_output_style_enabled)
      ?? true,
  };

  const guardedSections: GuardedSection[] = [];
  if (agentDefinition) {
    guardedSections.push({
      section: {
        name: `agent-definition-${agentDefinition.agentType}`,
        cacheBreak: false,
        compute: () => {
          const lines = [
            '# Prompt Optimization · Agent Contract',
            `agent_type=${agentDefinition.agentType}`,
            `when_to_use=${agentDefinition.whenToUse}`,
            agentDefinition.getSystemPrompt(),
          ];
          return lines.join('\n');
        },
      },
      requiredFeatureFlags: ['prompt_agent_definition'],
    });
  }

  guardedSections.push({
    section: FUNCTION_RESULT_CLEARING_SECTION,
    requiredFeatureFlags: ['prompt_frc'],
  });

  guardedSections.push({
    section: AUTONOMOUS_WORK_SECTION,
    requiredFeatureFlags: ['prompt_autonomous'],
    applicableSessionTypes: ['heartbeat'],
  });

  guardedSections.push({
    section: getOutputStyleSection(outputStyle),
    requiredFeatureFlags: ['prompt_output_style'],
  });

  const filtered = filterSections(guardedSections, {
    availableTools: new Set(availableToolNames ?? []),
    featureFlags,
    sessionType,
    agentType,
    ...(outputStyle ? { outputStyle } : {}),
  });

  const sections = filtered
    .map((section) => {
      const computed = section.compute();
      return typeof computed === 'string' ? computed.trim() : '';
    })
    .filter((item) => item.length > 0);
  if (sections.length === 0) return undefined;

  return [
    '# Prompt Optimization Runtime',
    `enabled=true`,
    `role=${role}`,
    `agent_type=${agentType}`,
    `session_type=${sessionType}`,
    ...sections,
  ].join('\n\n');
}

function parseOutputStyle(metadata: Record<string, unknown> | undefined): OutputStyle | undefined {
  const raw = parseOptionalString(metadata?.outputStyle)
    ?? parseOptionalString(metadata?.output_style)
    ?? parseOptionalString(metadata?.responseStyle)
    ?? parseOptionalString(metadata?.response_style);
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'concise' || normalized === 'detailed' || normalized === 'technical') {
    return normalized;
  }
  return undefined;
}

function mapDeveloperRoleToPromptAgentType(role: ChatCodexDeveloperRole): string {
  return role === 'system' ? 'system' : 'project';
}

function buildContinuityDeveloperInstructions(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined,
  metadata: Record<string, unknown> | undefined,
): string {
  const source = parseOptionalString(metadata?.contextHistorySource) ?? 'unknown';
  const recentUsers = (history ?? [])
    .filter((item) => item.role === 'user' && typeof item.content === 'string' && item.content.trim().length > 0)
    .slice(-10)
    .map((item, index) => `${index + 1}. ${truncateInlineText(item.content, 180)}`);
  const recentTaskTurns = extractRecentTaskTurnsFromHistory(history, 2)
    .map((task, index) => {
      const preview = task
        .map((item) => `${item.role}: ${truncateInlineText(item.content, 120)}`)
        .join(' | ');
      return `${index + 1}. ${preview}`;
    });

  if (recentUsers.length === 0 && recentTaskTurns.length === 0) {
    return [
      '[conversation_continuity]',
      `history_source=${source}`,
      'No recent continuity anchors were extracted from visible history.',
      'If the current request seems disconnected from the visible context, consider `context_builder.rebuild` with `current_prompt`.',
    ].join('\n');
  }

  return [
    '[conversation_continuity]',
    `history_source=${source}`,
    'Visible history keeps continuity anchors on purpose even after rebuild: recent task turns and recent user inputs are preserved to help you judge whether the thread is continuous.',
    'Use these anchors to decide whether the user is continuing the same topic, switching topics, or resuming interrupted work.',
    'If the current request is clearly discontinuous with these anchors, call `context_builder.rebuild` with `current_prompt` before proceeding.',
    recentTaskTurns.length > 0 ? 'recent_task_turns=' : '',
    ...recentTaskTurns,
    recentUsers.length > 0 ? 'recent_user_inputs=' : '',
    ...recentUsers,
  ].filter((line) => line.length > 0).join('\n');
}

// 新增：判断文本是否为工具调用（应该过滤掉，避免 /dev/null 死循环）
function isToolCallText(content: string): boolean {
  if (!content || typeof content !== 'string') return false;

  // 工具调用特征文本（cat /dev/null 等无效调用）
  const toolCallPatterns = [
    '调用工具:',
    '工具完成:',
    'exec_command',
    'grep',
    'cat @',
    'ls @',
    'head @',
    'tail @',
    '/dev/null',
  ];

  return toolCallPatterns.some(pattern => content.includes(pattern));
}

function extractRecentTaskTurnsFromHistory(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined,
  taskCount = 2,
): Array<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> {
  if (!Array.isArray(history) || history.length === 0) return [];
  const turns: Array<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>> = [];
  let current: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [];
  for (const item of history) {
    if (item.role === 'user' && current.length > 0) {
      turns.push(current);
      current = [];
    }
    // 过滤掉工具调用文本
    if (!isToolCallText(item.content)) {
      current.push(item);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns.slice(-Math.max(1, Math.floor(taskCount)));
}

function truncateInlineText(value: string, maxChars: number): string {
  // 先过滤掉工具调用文本
  if (isToolCallText(value)) {
    return '[已过滤]'; // 完全过滤，避免模型看到 /dev/null 等无效操作
  }
  const flattened = value.replace(/\s+/g, ' ').trim();
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, Math.max(0, maxChars - 3))}...`;
}

function resolveDeveloperRoleFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ChatCodexDeveloperRole {
  const candidates = [
    parseOptionalString(metadata?.roleProfile),
    parseOptionalString(metadata?.role_profile),
    parseOptionalString(metadata?.contextLedgerRole),
    parseOptionalString(metadata?.context_ledger_role),
    parseOptionalString(metadata?.role),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    return normalizeDeveloperRole(candidate);
  }
  return 'project';
}

function normalizeDeveloperRole(role: string): ChatCodexDeveloperRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'system') return 'system';
  return 'project';
}

function buildLedgerDeveloperInstructions(
  metadata: Record<string, unknown> | undefined,
  role: ChatCodexDeveloperRole,
): string {
  const enabled = parseOptionalBoolean(metadata?.contextLedgerEnabled) ?? true;
  const agentId = parseOptionalString(metadata?.contextLedgerAgentId) ?? 'chat-codex';
  const ledgerRole = parseOptionalString(metadata?.contextLedgerRole) ?? role;
  const mode = parseOptionalString(metadata?.kernelMode) ?? parseOptionalString(metadata?.mode) ?? 'main';
  const defaultCanReadAll = role === 'project'
    ? BASE_AGENT_ROLE_CONFIG.project.defaultLedgerCanReadAll
      : BASE_AGENT_ROLE_CONFIG.project.defaultLedgerCanReadAll;
  const canReadAll = parseOptionalBoolean(metadata?.contextLedgerCanReadAll) ?? defaultCanReadAll;
  const readableAgents = Array.isArray(metadata?.contextLedgerReadableAgents)
    ? metadata.contextLedgerReadableAgents
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];
  const focusEnabled = parseOptionalBoolean(metadata?.contextLedgerFocusEnabled) ?? true;
  const focusMaxChars = parseOptionalNumber(metadata?.contextLedgerFocusMaxChars) ?? 20_000;
  const workingSetTaskBlockCount = parseOptionalNumber(metadata?.workingSetTaskBlockCount);
  const historicalTaskBlockCount = parseOptionalNumber(metadata?.historicalTaskBlockCount);
  const workingSetMessageCount = parseOptionalNumber(metadata?.workingSetMessageCount);
  const historicalMessageCount = parseOptionalNumber(metadata?.historicalMessageCount);
  const workingSetTokens = parseOptionalNumber(metadata?.workingSetTokens);
  const historicalTokens = parseOptionalNumber(metadata?.historicalTokens);

  const lines = [
    '[context_ledger]',
    `enabled=${enabled ? 'true' : 'false'}`,
    `agent_id=${agentId}`,
    `role=${ledgerRole}`,
    `mode=${mode}`,
    `can_read_all=${canReadAll ? 'true' : 'false'}`,
    `readable_agents=${readableAgents.join(',')}`,
    `focus_enabled=${focusEnabled ? 'true' : 'false'}`,
    `focus_max_chars=${focusMaxChars}`,
    workingSetTaskBlockCount !== undefined ? `working_set_task_blocks=${workingSetTaskBlockCount}` : '',
    historicalTaskBlockCount !== undefined ? `historical_task_blocks=${historicalTaskBlockCount}` : '',
    workingSetMessageCount !== undefined ? `working_set_messages=${workingSetMessageCount}` : '',
    historicalMessageCount !== undefined ? `historical_messages=${historicalMessageCount}` : '',
    workingSetTokens !== undefined ? `working_set_tokens=${workingSetTokens}` : '',
    historicalTokens !== undefined ? `historical_tokens=${historicalTokens}` : '',
    '[context_partitions]',
    'P0.core_instructions=system+developer prompts (stable, never rewritten by history rebuild)',
    'P1.runtime_capabilities=skills+mailbox+flow runtime blocks (stable, injected independently from history)',
    'P2.current_turn=current user input + current-turn attachments/input items (highest priority for this turn)',
    'P3.continuity_anchors=recent task turns + recent user inputs for continuity judgment',
    'P4.dynamic_history=working_set + historical_memory (ledger-selected, budgeted, mutable)',
    'P5.canonical_storage=context ledger raw records + MEMORY.md (not fully injected)',
    'rebuild_scope=P4 only',
    'Current prompt history is a budgeted dynamic view, not the full ledger.',
    'working_set contains the active task block at higher fidelity; historical_memory contains relevance-selected prior blocks.',
    'Stable layers such as system/developer prompts, skills, mailbox summaries, and current user input are injected separately from historical recall.',
    'Query order: MEMORY.md (durable facts) -> context_ledger.memory search -> context_ledger.memory query(detail=true,slot_start,slot_end) -> context_ledger.expand_task(task_id or slot range).',
    'Absence from the visible prompt does not prove the event never happened.',
    enabled
      ? 'When historical context is missing, first call `context_ledger.memory` with action="search", then inspect raw entries with action="query", detail=true, slot_start, and slot_end.'
      : 'Do not call `context_ledger.memory` because ledger is disabled for this turn.',
    'Treat compact/focus hits as retrieval hints and verify important claims with detailed ledger query before relying on them.',
    'Do not guess hidden history; retrieve evidence from ledger first.',
  ];
  return lines.filter((line) => line.length > 0).join('\n');
}

function resolveUserInstructions(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    parseOptionalString(metadata?.agentsInstructions),
    parseOptionalString(metadata?.agents_instructions),
    parseOptionalString(metadata?.userInstructions),
    parseOptionalString(metadata?.user_instructions),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (candidates.length === 0) return undefined;
  const merged = Array.from(new Set(candidates.map((item) => item.trim())));
  return merged.join('\n\n');
}

function resolveTurnContext(
  metadata: Record<string, unknown> | undefined,
): KernelUserTurnOptions['turn_context'] | undefined {
  const cwd = parseOptionalString(metadata?.cwd) ?? process.cwd();
  const approval = parseOptionalString(metadata?.approval) ?? 'never';
  const sandbox = parseOptionalString(metadata?.sandbox) ?? 'danger-full-access';
  const model = parseOptionalString(metadata?.model);

  return {
    cwd,
    approval,
    sandbox,
    ...(model ? { model } : {}),
  };
}

function resolveEnvironmentContext(
  metadata: Record<string, unknown> | undefined,
  turnContext: KernelUserTurnOptions['turn_context'] | undefined,
): string | undefined {
  const fromMetadata = parseOptionalString(metadata?.environmentContext);
  if (fromMetadata) return fromMetadata;
  if (!turnContext) return undefined;

  const lines = [
    `cwd=${turnContext.cwd ?? process.cwd()}`,
    `shell=${process.env.SHELL ?? 'unknown'}`,
  ];
  if (turnContext.model) lines.push(`model=${turnContext.model}`);
  return lines.join('\n');
}

function resolveContextWindow(
  metadata: Record<string, unknown> | undefined,
): KernelUserTurnOptions['context_window'] | undefined {
  const maxInputTokens =
    parseOptionalNumber(metadata?.maxInputTokens)
    ?? parseOptionalNumber(metadata?.max_input_tokens)
    ?? parseOptionalNumber(metadata?.modelContextWindow)
    ?? parseOptionalNumber(metadata?.model_context_window)
    ?? resolveContextWindowFromFingerConfig(metadata);
  const baselineTokens =
    parseOptionalNumber(metadata?.baselineTokens)
    ?? parseOptionalNumber(metadata?.baseline_tokens);
  const thresholdRatio =
    parseOptionalNumber(metadata?.autoCompactThresholdRatio)
    ?? parseOptionalNumber(metadata?.auto_compact_threshold_ratio);

  if (
    maxInputTokens === undefined &&
    baselineTokens === undefined &&
    thresholdRatio === undefined
  ) {
    return undefined;
  }

  return {
    ...(maxInputTokens !== undefined ? { max_input_tokens: maxInputTokens } : {}),
    ...(baselineTokens !== undefined ? { baseline_tokens: baselineTokens } : {}),
    ...(thresholdRatio !== undefined ? { auto_compact_threshold_ratio: thresholdRatio } : {}),
  };
}

function resolveContextWindowFromFingerConfig(metadata: Record<string, unknown> | undefined): number | undefined {
  const defaultWindow = readDefaultContextWindow();
  const snapshot = readFingerKernelConfigSnapshot();
  if (!snapshot) {
    const inferred = inferModelContextWindowFromMetadata(metadata);
    if (typeof inferred === 'number' && Number.isFinite(inferred) && inferred > 0) return Math.floor(inferred);
    return defaultWindow;
  }

  const providerId = resolveProviderIdForContextWindow(metadata, snapshot.activeProviderId);
  if (providerId && snapshot.providers[providerId]?.maxInputTokens !== undefined) {
    return snapshot.providers[providerId].maxInputTokens;
  }
  if (providerId) {
    const model = snapshot.providers[providerId]?.model;
    const inferred = inferModelContextWindow(model);
    if (inferred !== undefined) return inferred;
  }

  if (snapshot.globalMaxInputTokens !== undefined) return snapshot.globalMaxInputTokens;
  const inferred = inferModelContextWindowFromMetadata(metadata);
  if (typeof inferred === 'number' && Number.isFinite(inferred) && inferred > 0) return Math.floor(inferred);
  return defaultWindow;
}

function readDefaultContextWindow(): number {
  try {
    const value = getContextWindow();
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  } catch {
    // ignore and fallback to built-in default
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function resolveProviderIdForContextWindow(
  metadata: Record<string, unknown> | undefined,
  fallbackProviderId: string | undefined,
): string | undefined {
  const fromKernelProviderId = parseOptionalString(metadata?.kernelProviderId);
  if (fromKernelProviderId) return fromKernelProviderId;
  const fromProviderId = parseOptionalString(metadata?.providerId);
  if (fromProviderId) return fromProviderId;
  const fromProvider = parseOptionalString(metadata?.provider);
  if (fromProvider) return fromProvider;
  if (fallbackProviderId) return fallbackProviderId;
  return resolveActiveProviderIdFromUserSettings();
}

function inferModelContextWindowFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  const modelFromMetadata =
    parseOptionalString(metadata?.model)
    ?? parseOptionalString(metadata?.kernelModel)
    ?? parseOptionalString(metadata?.model_name);
  if (modelFromMetadata) {
    const inferred = inferModelContextWindow(modelFromMetadata);
    if (inferred !== undefined) return inferred;
  }

  const snapshot = readFingerKernelConfigSnapshot();
  const providerId = resolveProviderIdForContextWindow(metadata, snapshot?.activeProviderId);
  if (!providerId || !snapshot?.providers[providerId]?.model) return undefined;
  return inferModelContextWindow(snapshot.providers[providerId].model);
}

function inferModelContextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;

  if (/^gpt-5(\.\d+)?-codex(?:-(?:mini|max))?$/.test(normalized)) {
    return 272_000;
  }
  if (normalized === 'gpt-5-codex' || normalized === 'gpt-5-codex-mini' || normalized === 'gpt-5-codex-max') {
    return 272_000;
  }
  return undefined;
}

interface FingerKernelProviderSnapshot {
  model?: string;
  maxInputTokens?: number;
}

interface FingerKernelConfigSnapshot {
  activeProviderId?: string;
  providers: Record<string, FingerKernelProviderSnapshot>;
  globalMaxInputTokens?: number;
}

function readFingerKernelConfigSnapshot(): FingerKernelConfigSnapshot | undefined {
  try {
    const aiProviders = loadAIProviders();
    const activeProviderId = parseOptionalString(aiProviders.default);
    const providers: Record<string, FingerKernelProviderSnapshot> = {};

    const providerEntries = aiProviders.providers && isRecord(aiProviders.providers)
      ? Object.entries(aiProviders.providers)
      : [];
    for (const [providerId, value] of providerEntries) {
      if (!isRecord(value)) continue;
      providers[providerId] = {
        ...(parseOptionalString(value.model) ? { model: parseOptionalString(value.model) } : {}),
      };
    }

    return {
      ...(activeProviderId ? { activeProviderId } : {}),
      providers,
    };
  } catch {
    return undefined;
  }
}

function resolveCompactConfig(
  metadata: Record<string, unknown> | undefined,
): KernelUserTurnOptions['compact'] | undefined {
  const manual = metadata?.compactManual === true;
  const preserveUserMessages = metadata?.preserveUserMessages !== false;
  const summaryHint = parseOptionalString(metadata?.compactSummaryHint);

  if (!manual && preserveUserMessages && !summaryHint) {
    return undefined;
  }

  return {
    ...(manual ? { manual: true } : {}),
    ...(preserveUserMessages !== true ? { preserve_user_messages: false } : {}),
    ...(summaryHint ? { summary_hint: summaryHint } : {}),
  };
}

function resolveForkUserMessageIndex(metadata: Record<string, unknown> | undefined): number | undefined {
  const raw = metadata?.forkUserMessageIndex;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.floor(raw);
}

function resolveContextLedger(
  metadata: Record<string, unknown> | undefined,
  sessionId: string | undefined,
): KernelUserTurnOptions['context_ledger'] | undefined {
  const enabled = metadata?.contextLedgerEnabled !== false;
  if (!enabled) return undefined;

  const rootDir = parseOptionalString(metadata?.contextLedgerRootDir)
    ?? parseOptionalString(metadata?.contextLedgerRoot)
    ?? undefined;
  const agentId = parseOptionalString(metadata?.contextLedgerAgentId) ?? 'chat-codex';
  const role = parseOptionalString(metadata?.contextLedgerRole) ?? parseOptionalString(metadata?.roleProfile);
  const mode = parseOptionalString(metadata?.kernelMode) ?? parseOptionalString(metadata?.mode) ?? 'main';
  const canReadAll = metadata?.contextLedgerCanReadAll === true;
  const readableAgents = Array.isArray(metadata?.contextLedgerReadableAgents)
    ? metadata.contextLedgerReadableAgents
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];
  const focusMaxChars = parseOptionalNumber(metadata?.contextLedgerFocusMaxChars) ?? 20_000;
  const focusEnabled = metadata?.contextLedgerFocusEnabled !== false;

  if (!sessionId || sessionId.trim().length === 0) return undefined;

  return {
    enabled: true,
    ...(rootDir ? { root_dir: rootDir } : {}),
    agent_id: agentId,
    ...(role ? { role } : {}),
    mode,
    can_read_all: canReadAll,
    readable_agents: readableAgents,
    focus_enabled: focusEnabled,
    focus_max_chars: focusMaxChars,
  };
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

async function resolveToolSpecifications(
  toolNames: string[] | undefined,
  resolver:
    | ((toolNames: string[]) => Promise<ChatCodexToolSpecification[]> | ChatCodexToolSpecification[])
    | undefined,
): Promise<ChatCodexToolSpecification[]> {
  const normalizedNames = Array.from(
    new Set(
      (toolNames ?? [])
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );

  if (normalizedNames.length === 0) return [];

  if (!resolver) {
    return normalizedNames.map((name) => ({
      name,
      description: `Execute ${name}`,
      inputSchema: { type: 'object', additionalProperties: true },
    }));
  }

  try {
    const resolved = await resolver(normalizedNames);
    const sanitized = (resolved ?? [])
      .filter((item) => item && typeof item.name === 'string' && item.name.trim().length > 0)
      .map((item) => ({
        name: item.name.trim(),
        description: typeof item.description === 'string' ? item.description : undefined,
        inputSchema: isRecord(item.inputSchema) ? item.inputSchema : undefined,
      }));

    if (sanitized.length > 0) {
      const known = new Set(sanitized.map((item) => item.name));
      const missing = normalizedNames
        .filter((name) => !known.has(name))
        .map((name) => defaultToolSpecification(name));
      return [...sanitized, ...missing];
    }
  } catch {
    // noop, fallback below
  }

  return normalizedNames.map((name) => defaultToolSpecification(name));
}

function isToolSpecificationLike(value: unknown): value is ChatCodexToolSpecification {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim().length > 0;
}

function normalizeProvidedToolSpecifications(
  specs: ChatCodexToolSpecification[],
): ChatCodexToolSpecification[] {
  const seen = new Set<string>();
  const normalized: ChatCodexToolSpecification[] = [];
  for (const spec of specs) {
    if (!isToolSpecificationLike(spec)) continue;
    const name = spec.name.trim();
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push({
      name,
      ...(typeof spec.description === 'string' ? { description: spec.description } : {}),
      ...(isRecord(spec.inputSchema) ? { inputSchema: spec.inputSchema } : {}),
    });
  }
  return normalized;
}

function defaultToolSpecification(name: string): ChatCodexToolSpecification {
  if (name === 'user.ask') {
    return {
      name,
      description:
        'Blocking user decision gate. Use only when execution is truly blocked by critical decision or missing credentials.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          context: { type: 'string' },
          blocking_reason: { type: 'string' },
          decision_impact: { type: 'string', enum: ['critical', 'major', 'normal'] },
          timeout_ms: { type: 'number' },
          session_id: { type: 'string' },
          workflow_id: { type: 'string' },
          epic_id: { type: 'string' },
          agent_id: { type: 'string' },
        },
        required: ['question'],
        additionalProperties: false,
      },
    };
  }

  if (name === 'context_ledger.memory') {
    return {
      name,
      description:
        'Canonical history truth tool (ledger is full raw timeline). Always follow this retrieval order: (1) action="search" to locate relevant task blocks/slots, (2) action="query" with detail=true + slot_start/slot_end to read exact raw evidence, (3) if search hit is compact digest, call context_ledger.expand_task to restore full task records. Do not assume prompt history is complete.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'search', 'index', 'compact', 'delete_slots', 'digest_backfill', 'digest_incremental'], description: 'Use search/query for historical retrieval; digest_backfill can one-shot synthesize full task digests; digest_incremental appends digest only for newly added ledger range since last compaction; other actions are maintenance only.' },
          session_id: { type: 'string', description: 'Optional session scope override. Usually auto-filled by runtime.' },
          agent_id: { type: 'string', description: 'Ledger owner agent id. Requires permission when reading other agents.' },
          mode: { type: 'string', description: 'Conversation mode / thread name, such as main or review.' },
          since_ms: { type: 'number', description: 'Inclusive start timestamp in unix milliseconds.' },
          until_ms: { type: 'number', description: 'Inclusive end timestamp in unix milliseconds.' },
          limit: { type: 'number', description: 'Maximum records to return.' },
          slot_start: { type: 'number', description: '1-based slot start for detailed query.' },
          slot_end: { type: 'number', description: '1-based slot end for detailed query.' },
          contains: { type: 'string', description: 'Keyword/topic search text. Search also returns task-block overflow candidates.' },
          fuzzy: { type: 'boolean', description: 'Enable compact/fuzzy/task-block recall before detailed lookup.' },
          detail: { type: 'boolean', description: 'When true with query, return raw ledger entries for the slot window.' },
          event_types: { type: 'array', items: { type: 'string' }, description: 'Optional event type filter.' },
          text: { type: 'string', description: 'Reserved for maintenance flows; not needed for normal history lookup.' },
          append: { type: 'boolean', description: 'Reserved for maintenance flows.' },
          focus_max_chars: { type: 'number', description: 'Optional focus text budget.' },
        },
        additionalProperties: true,
      },
    };
  }

  if (name === 'context_builder.rebuild') {
    return {
      name,
      description:
        'Rebuild dynamic history from ledger digests into working_set + historical_memory. historical_memory should be digest-first; expand to full records only when needed via context_ledger.expand_task. Use when topic changed, evidence is missing, or history context is empty. Default budget is 20k (prefer 50k for complex coding/debugging, 110k only if still insufficient).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Optional session id override. Usually auto-filled from tool context.' },
          agent_id: { type: 'string', description: 'Optional agent id override. Usually auto-filled from tool context.' },
          mode: { type: 'string', enum: ['minimal', 'moderate', 'aggressive'], description: 'Context build mode override for this rebuild.' },
          target_budget: { type: 'number', description: 'Optional token budget override for this rebuild. Default is 20k when not configured otherwise.' },
          rebuild_budget: { type: 'number', description: 'Preferred rebuild budget alias. Recommended ladder: 50k first for coding/debugging, 110k only if 50k is insufficient.' },
          budget_tokens: { type: 'number', description: 'Alias for rebuild token budget; same meaning as rebuild_budget/target_budget.' },
          current_prompt: { type: 'string', description: 'Current user intent/topic used for relevance sorting.' },
          include_messages: { type: 'boolean', description: 'Whether to include compact message previews in output.' },
          message_limit: { type: 'number', description: 'Max preview messages when include_messages=true.' },
        },
        additionalProperties: true,
      },
    };
  }

  if (name === 'context_ledger.expand_task') {
    return {
      name,
      description:
        'Expand one historical digest/task block into full raw ledger entries and return slot-aligned details. Prefer task_id (stable id aligned with ledger), fallback to slot_start/slot_end. After expansion, use returned full entries as concrete historical_memory evidence for current reasoning.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Optional session id override. Usually auto-filled from tool context.' },
          agent_id: { type: 'string', description: 'Optional agent id override. Usually auto-filled from tool context.' },
          mode: { type: 'string', description: 'Conversation mode / thread, defaults to main.' },
          task_id: { type: 'string', description: 'Task digest/task_block id to expand (preferred).' },
          slot_start: { type: 'number', description: '1-based ledger slot start; use with slot_end if task_id is unavailable.' },
          slot_end: { type: 'number', description: '1-based ledger slot end; use with slot_start if task_id is unavailable.' },
        },
        additionalProperties: true,
      },
    };
  }

  return {
    name,
    description: `Execute ${name}`,
    inputSchema: { type: 'object', additionalProperties: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export const __chatCodexInternals = {
  buildKernelUserTurnOptions,
  resolveDeveloperInstructions,
  resolveDeveloperRoleFromMetadata,
  normalizeDeveloperRole,
  buildLedgerDeveloperInstructions,
  resolveUserInstructions,
  resolveTurnContext,
  resolveEnvironmentContext,
  inferModelContextWindow,
  normalizeRunnerSessionId,
  resolveRunnerRuntimeKey,
};
