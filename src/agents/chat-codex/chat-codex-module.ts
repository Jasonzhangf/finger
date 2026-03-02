import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { createInterface } from 'readline';
import type { OutputModule } from '../../orchestration/module-registry.js';
import { KernelAgentBase, type KernelAgentRunner } from '../base/kernel-agent-base.js';
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

const DEFAULT_KERNEL_TIMEOUT_MS = 600_000;
const DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT = 5;
export const CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.orchestrator.allowedTools,
];
export const CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.executor.allowedTools,
];
export const CHAT_CODEX_REVIEWER_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.reviewer.allowedTools,
];
export const CHAT_CODEX_SEARCHER_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.searcher.allowedTools,
];
export const CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS = CHAT_CODEX_SEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODER_ALLOWED_TOOLS = CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS;
export const CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS = CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS;

type ChatCodexRoleProfileId =
  | 'orchestrator'
  | 'executor'
  | 'reviewer'
  | 'searcher'
  | 'researcher'
  | 'coder'
  | 'coding-cli'
  | 'router'
  | 'general';

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
  resolveToolSpecifications?: (toolNames: string[]) => Promise<ChatCodexToolSpecification[]> | ChatCodexToolSpecification[];
  toolExecution?: ChatCodexToolExecutionConfig;
  onLoopEvent?: (event: ChatCodexLoopEvent) => void | Promise<void>;
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

export interface ChatCodexRunContext {
  sessionId?: string;
  systemPrompt?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  metadata?: Record<string, unknown>;
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
  resolve: (value: ChatCodexRunResult) => void;
  reject: (reason?: unknown) => void;
  events: ChatCodexKernelEvent[];
  replyText?: string;
  kernelMetadata?: Record<string, unknown>;
  timeout: NodeJS.Timeout;
  settled: boolean;
  seenSessionConfigured: boolean;
  onKernelEvent?: (event: ChatCodexKernelEvent) => void;
}

interface KernelSessionProcess {
  key: string;
  child: ChildProcessWithoutNullStreams;
  resolvedBinaryPath: string;
  providerId: string;
  stderrBuffer: string;
  submissionSeq: number;
  activeTurn: ActiveKernelTurn | null;
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
  version: '0.1.0',
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
  void Promise.resolve(callback(event)).catch(() => {});
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('timed out') || normalized.includes('timeout');
}

function isRetryableRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('daily_cost_limit_exceeded')) return false;
  if (normalized.includes('insufficient_quota')) return false;
  if (normalized.includes('unauthorized')) return false;
  if (normalized.includes('forbidden')) return false;
  if (normalized.includes('http 401') || normalized.includes('http_401')) return false;
  if (normalized.includes('http 402') || normalized.includes('http_402')) return false;
  if (normalized.includes('http 403') || normalized.includes('http_403')) return false;

  return isTimeoutError(error)
    || normalized.includes('fetch failed')
    || normalized.includes('gateway')
    || normalized.includes('result timeout')
    || normalized.includes('ack timeout')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up')
    || normalized.includes('http 408')
    || normalized.includes('http 409')
    || normalized.includes('http 425')
    || normalized.includes('http 429')
    || normalized.includes('http 500')
    || normalized.includes('http 502')
    || normalized.includes('http 503')
    || normalized.includes('http 504');
}

function retryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  const clampedAttempt = Math.max(1, attempt);
  return Math.min(30_000, Math.floor(750 * Math.pow(2, clampedAttempt - 1)));
}

export class ProcessChatCodexRunner implements ChatCodexRunner {
  private readonly timeoutMs: number;
  private readonly binaryPath?: string;
  private readonly toolExecution?: ChatCodexToolExecutionConfig;
  private readonly developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
  private readonly sessions = new Map<string, KernelSessionProcess>();

  constructor(options: Pick<ChatCodexModuleConfig, 'timeoutMs' | 'binaryPath' | 'toolExecution' | 'developerPromptPaths'>) {
    this.timeoutMs = options.timeoutMs;
    this.binaryPath = options.binaryPath;
    this.toolExecution = options.toolExecution;
    this.developerPromptPaths = options.developerPromptPaths;
  }

  async runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
    const resolvedPath = resolveKernelBinaryPath(this.binaryPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`kernel bridge binary not found: ${resolvedPath}`);
    }

    const providerId = resolveRunnerProviderId(context);
    const sessionKey = resolveRunnerSessionKey(context?.sessionId, providerId);
    const session = this.ensureSession(sessionKey, resolvedPath, providerId);
    const normalizedItems = normalizeKernelInputItems(items, text);
    const options = buildKernelUserTurnOptions(context, this.toolExecution, this.developerPromptPaths);
    if (session.activeTurn) {
      const pendingTurnId = this.nextSubmissionId(session, 'pending');
      this.sendUserTurnSubmission(session, pendingTurnId, normalizedItems, options);
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
      const timeout = setTimeout(() => {
        this.rejectActiveTurn(
          session,
          new Error(`chat-codex timed out after ${this.timeoutMs}ms`),
          true,
        );
      }, this.timeoutMs);

      session.activeTurn = {
        id: turnId,
        resolve,
        reject,
        events: [],
        timeout,
        settled: false,
        seenSessionConfigured: false,
        onKernelEvent: context?.onKernelEvent,
      };

      this.sendUserTurnSubmission(session, turnId, normalizedItems, options);
    });
  }

  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
    const states: ChatCodexRunnerSessionState[] = [];
    for (const [sessionKey, session] of this.sessions.entries()) {
      const parsed = parseRunnerSessionKey(sessionKey);
      if (!parsed) continue;
      if (normalizedSessionId.length > 0 && parsed.sessionId !== normalizedSessionId) continue;
      if (normalizedProviderId.length > 0 && parsed.providerId !== normalizedProviderId) continue;
      states.push({
        sessionKey,
        sessionId: parsed.sessionId,
        providerId: parsed.providerId,
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
      const parsed = parseRunnerSessionKey(sessionKey);
      if (!parsed) continue;
      if (parsed.sessionId !== normalizedSessionId) continue;
      if (normalizedProviderId.length > 0 && parsed.providerId !== normalizedProviderId) continue;
      const hadActiveTurn = session.activeTurn !== null;
      const activeTurnId = session.activeTurn?.id;
      if (hadActiveTurn) {
        this.rejectActiveTurn(session, new Error('chat-codex turn interrupted by user'), true);
      } else {
        this.disposeSession(session);
      }
      results.push({
        sessionKey,
        sessionId: parsed.sessionId,
        providerId: parsed.providerId,
        hadActiveTurn,
        interrupted: hadActiveTurn,
        ...(activeTurnId ? { activeTurnId } : {}),
      });
    }
    return results;
  }

  private ensureSession(sessionKey: string, resolvedBinaryPath: string, providerId: string): KernelSessionProcess {
    const existing = this.sessions.get(sessionKey);
    if (
      existing
      && !existing.child.killed
      && existing.resolvedBinaryPath === resolvedBinaryPath
      && existing.providerId === providerId
    ) {
      return existing;
    }

    if (existing) {
      this.disposeSession(existing);
    }

    const spawnEnv = {
      ...process.env,
      FINGER_KERNEL_PROVIDER: providerId,
    };
    const child = spawn(resolvedBinaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    }) as ChildProcessWithoutNullStreams;

    const session: KernelSessionProcess = {
      key: sessionKey,
      child,
      resolvedBinaryPath,
      providerId,
      stderrBuffer: '',
      submissionSeq: 0,
      activeTurn: null,
    };
    this.sessions.set(sessionKey, session);
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

    session.child.on('error', (error: Error) => {
      this.rejectActiveTurn(session, error, true);
      this.sessions.delete(session.key);
    });

    session.child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
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
    } catch {
      // ignore callback failures to avoid breaking kernel stream
    }
  }

  private resolveActiveTurn(session: KernelSessionProcess, result: ChatCodexRunResult): void {
    const activeTurn = session.activeTurn;
    if (!activeTurn || activeTurn.settled) return;
    activeTurn.settled = true;
    clearTimeout(activeTurn.timeout);
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
    session.activeTurn = null;
    activeTurn.reject(error);
    if (terminateSession) {
      this.disposeSession(session);
    }
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
    if (!session.child.stdin.writable) {
      throw new Error(`chat-codex kernel stdin is not writable for session ${session.key}`);
    }
    session.child.stdin.write(`${JSON.stringify(submission)}\n`);
  }

  private disposeSession(session: KernelSessionProcess): void {
    try {
      if (!session.child.killed) {
        session.child.kill('SIGTERM');
      }
    } catch {
      // ignore dispose errors
    }
    this.sessions.delete(session.key);
  }

  private nextSubmissionId(session: KernelSessionProcess, kind: 'turn' | 'pending'): string {
    session.submissionSeq += 1;
    return `${kind}-${Date.now()}-${session.submissionSeq}`;
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

  const resolveCodingPrompt = (): string => resolveCodingCliSystemPrompt(mergedConfig.codingPromptPath);
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
    runTurn: async (text: string, context) => {
      const inputItems = parseKernelInputItems(context?.metadata);
      const sessionId = context?.sessionId ?? 'unknown';
      const toolSpecifications = await resolveToolSpecifications(context?.tools, mergedConfig.resolveToolSpecifications);
      const mode = parseOptionalString(context?.metadata?.kernelMode) ?? parseOptionalString(context?.metadata?.mode) ?? 'main';
      const reviewMeta = isRecord(context?.metadata?.review) ? context.metadata.review : undefined;
      const reviewIteration = parseOptionalNumber(reviewMeta?.iteration);
      const reviewPhase = parseOptionalString(reviewMeta?.phase);
      const snapshotContext: ChatCodexRunContext = {
        sessionId,
        systemPrompt: context?.systemPrompt,
        history: context?.history?.map((item) => ({
          role: item.role === 'system' ? 'system' : item.role === 'assistant' ? 'assistant' : 'user',
          content: item.content,
        })),
        metadata: context?.metadata,
        tools: toolSpecifications,
        toolExecution: mergedConfig.toolExecution,
      };
      const optionsSnapshot = buildKernelUserTurnOptions(snapshotContext, mergedConfig.toolExecution, mergedConfig.developerPromptPaths);
      writePromptInjectionSnapshot({
        sessionId,
        text,
        systemPrompt: context?.systemPrompt,
        metadata: isRecord(context?.metadata) ? context?.metadata : undefined,
        roleProfile: parseOptionalString(context?.metadata?.roleProfile) ?? parseOptionalString(context?.metadata?.contextLedgerRole),
        toolSpecifications,
        inputItems,
        history: snapshotContext.history,
        options: optionsSnapshot,
      });

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_start',
        timestamp: new Date().toISOString(),
        payload: {
          text,
          inputItemCount: inputItems?.length ?? 0,
          inputTypes: (inputItems ?? []).map((item) => item.type),
          toolCount: toolSpecifications.length,
          mode,
          ...(reviewPhase ? { reviewPhase } : {}),
          ...(typeof reviewIteration === 'number' ? { reviewIteration } : {}),
        },
      });

      const isRealtimeKernelStepEvent = (eventType: string): boolean =>
        eventType === 'tool_call'
        || eventType === 'tool_result'
        || eventType === 'tool_error'
        || eventType === 'model_round';

      const emitSyntheticKernelEventsFromTaskComplete = (event: ChatCodexKernelEvent): boolean => {
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
            },
          });
        }

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
        if (event.msg.type === 'tool_call') {
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
          if (event.msg.error) payload.error = event.msg.error;
          if (typeof event.msg.duration_ms === 'number') payload.duration = event.msg.duration_ms;
        } else if (event.msg.type === 'model_round') {
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

      const normalizedTimeoutRetryCount = Number.isFinite(mergedConfig.timeoutRetryCount)
        ? Math.max(0, Math.floor(mergedConfig.timeoutRetryCount))
        : DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT;
      const maxAttempts = normalizedTimeoutRetryCount + 1;
      let runResult: ChatCodexRunResult | null = null;
      let lastRunError: unknown = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          runResult = await activeRunner.runTurn(text, inputItems, {
            sessionId,
            systemPrompt: context?.systemPrompt,
            history: context?.history,
            metadata: context?.metadata,
            tools: toolSpecifications,
            toolExecution: mergedConfig.toolExecution,
            onKernelEvent: (event) => {
              streamedKernelEventCount += 1;
              if (isRealtimeKernelStepEvent(event.msg.type)) {
                streamedRealtimeKernelStepCount += 1;
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
                error: error instanceof Error ? error.message : String(error),
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
              error: error instanceof Error ? error.message : String(error),
              attempt,
              maxAttempts,
              timeoutRetryCount: normalizedTimeoutRetryCount,
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
      }

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_complete',
        timestamp: new Date().toISOString(),
        payload: {
          replyPreview: runResult.reply.slice(0, 300),
          eventCount: runResult.events.length,
          finalKernelEvent: runResult.events.length > 0 ? runResult.events[runResult.events.length - 1].msg.type : null,
          mode,
          timeoutMs: mergedConfig.timeoutMs,
          timeoutRetryCount: normalizedTimeoutRetryCount,
          ...(reviewPhase ? { reviewPhase } : {}),
          ...(typeof reviewIteration === 'number' ? { reviewIteration } : {}),
        },
      });
      const stopReason = resolveStopReasonFromKernelMetadata(runResult.kernelMetadata);

      return {
        reply: runResult.reply,
        metadata: {
          binaryPath: runResult.usedBinaryPath,
          eventCount: runResult.events.length,
          kernelEventTypes: runResult.events.map((event) => event.msg.type),
          stopReason,
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
      maxContextMessages: 20,
      roleProfiles: {
        general: {
          id: 'general',
          allowedTools: CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS,
        },
        orchestrator: {
          id: 'orchestrator',
          allowedTools: CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS,
        },
        executor: {
          id: 'executor',
          allowedTools: CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS,
        },
        reviewer: {
          id: 'reviewer',
          allowedTools: CHAT_CODEX_REVIEWER_ALLOWED_TOOLS,
        },
        searcher: {
          id: 'searcher',
          allowedTools: CHAT_CODEX_SEARCHER_ALLOWED_TOOLS,
        },
        researcher: {
          id: 'researcher',
          allowedTools: CHAT_CODEX_SEARCHER_ALLOWED_TOOLS,
        },
        coder: {
          id: 'coder',
          allowedTools: CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS,
        },
        'coding-cli': {
          id: 'coding-cli',
          allowedTools: CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS,
        },
        router: {
          id: 'router',
          systemPrompt: ROUTER_SYSTEM_PROMPT,
          allowedTools: ['noop'],
        },
      },
    },
    kernelRunner,
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
  roleProfile?: string;
  toolSpecifications: ChatCodexToolSpecification[];
  inputItems?: KernelInputItem[];
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  options?: KernelUserTurnOptions;
}): void {
  try {
    const agentId = parseOptionalString(input.metadata?.contextLedgerAgentId) ?? 'unknown-agent';
    const roleProfile = parseOptionalString(input.roleProfile) ?? 'orchestrator';
    const filePath = resolvePromptInjectionLogPath(input.sessionId, input.metadata, agentId);
    const resolvedSystemPrompt = parseOptionalString(input.systemPrompt)
      ?? parseOptionalString(input.options?.system_prompt);
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
      injections: {
        developerInstructions: input.options?.developer_instructions ?? null,
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
    sessionRoot = basename(rootCandidate) === 'memory' ? dirname(rootCandidate) : rootCandidate;
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
  if (normalized === 'general') return 'orchestrator';
  if (normalized === 'researcher') return 'searcher';
  if (normalized === 'coder') return 'executor';
  if (
    normalized === 'orchestrator'
    || normalized === 'executor'
    || normalized === 'reviewer'
    || normalized === 'searcher'
    || normalized === 'coding-cli'
    || normalized === 'router'
  ) {
    return normalized;
  }
  return 'orchestrator';
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

function resolveRunnerSessionKey(sessionId: string | undefined, providerId: string): string {
  const normalizedSessionId =
    typeof sessionId === 'string' && sessionId.trim().length > 0
      ? sessionId.trim()
      : 'default';
  return `${normalizedSessionId}::provider=${providerId}`;
}

function parseRunnerSessionKey(sessionKey: string): { sessionId: string; providerId: string } | null {
  const marker = '::provider=';
  const markerIndex = sessionKey.indexOf(marker);
  if (markerIndex <= 0) return null;
  const sessionId = sessionKey.slice(0, markerIndex).trim();
  const providerId = sessionKey.slice(markerIndex + marker.length).trim();
  if (sessionId.length === 0 || providerId.length === 0) return null;
  return { sessionId, providerId };
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
  const fromConfig = resolveActiveProviderIdFromFingerConfig();
  if (fromConfig) return fromConfig;
  const fromEnv = parseOptionalString(process.env.FINGER_KERNEL_PROVIDER);
  if (fromEnv) return fromEnv;
  return 'crsb';
}

function resolveActiveProviderIdFromFingerConfig(): string | undefined {
  try {
    const configPath = FINGER_PATHS.config.file.main;
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf-8');
    if (raw.trim().length === 0) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isRecord(parsed.kernel)) return undefined;
    const kernel = parsed.kernel;
    if (typeof kernel.provider !== 'string') return undefined;
    const normalized = kernel.provider.trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function resolveKernelBinaryPath(configuredPath?: string): string {
  if (configuredPath && configuredPath.length > 0) return configuredPath;
  if (process.env.FINGER_KERNEL_BRIDGE_BIN && process.env.FINGER_KERNEL_BRIDGE_BIN.length > 0) {
    return process.env.FINGER_KERNEL_BRIDGE_BIN;
  }
  return join(process.cwd(), 'rust', 'target', 'debug', 'finger-kernel-bridge-bin');
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
  if (items && items.length > 0) return items;
  return [{ type: 'text', text: fallbackText }];
}

function buildKernelUserTurnOptions(
  context: ChatCodexRunContext | undefined,
  defaultToolExecution: ChatCodexToolExecutionConfig | undefined,
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>,
): KernelUserTurnOptions | undefined {
  const options: KernelUserTurnOptions = {};
  const metadata = context?.metadata;

  if (context?.systemPrompt && context.systemPrompt.trim().length > 0) {
    options.system_prompt = context.systemPrompt.trim();
  }

  if (context?.sessionId && context.sessionId.trim().length > 0) {
    options.session_id = context.sessionId.trim();
  }

  const mode = parseOptionalString(metadata?.kernelMode) ?? parseOptionalString(metadata?.mode) ?? 'main';
  options.mode = mode;

  const historyItems = resolveHistoryItems(context?.history, metadata);
  if (historyItems.length > 0) {
    options.history_items = historyItems;
  }

  const role = resolveDeveloperRoleFromMetadata(metadata);
  const developerInstructions = resolveDeveloperInstructions(metadata, developerPromptPaths, role);
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

function resolveHistoryItems(
  history: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined,
  metadata: Record<string, unknown> | undefined,
): Array<Record<string, unknown>> {
  const fromMetadata = metadata?.kernelApiHistory;
  if (Array.isArray(fromMetadata)) {
    const normalized = fromMetadata.filter((item): item is Record<string, unknown> => isRecord(item));
    if (normalized.length > 0) return normalized;
  }

  if (!history || history.length === 0) return [];
  return history
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
}

function resolveDeveloperInstructions(
  metadata: Record<string, unknown> | undefined,
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>,
  resolvedRole?: ChatCodexDeveloperRole,
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
  const contextSlotsRendered = parseOptionalString(metadata?.contextSlotsRendered)
    ?? parseOptionalString(metadata?.context_slots_rendered);

  const hints: string[] = [];
  if (collaborationMode) hints.push(`collaboration_mode=${collaborationMode}`);
  if (modelSwitchHint) hints.push(`model_switch_hint=${modelSwitchHint}`);

  const sections = [rolePrompt, ledgerBlock, contextSlotsRendered, hints.join('\n'), explicit]
    .map((item) => item?.trim() ?? '')
    .filter((item) => item.length > 0);
  if (sections.length === 0) return undefined;

  const deduped: string[] = [];
  for (const section of sections) {
    if (!deduped.includes(section)) deduped.push(section);
  }
  return deduped.join('\n\n');
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
  return 'orchestrator';
}

function normalizeDeveloperRole(role: string): ChatCodexDeveloperRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'router') return 'router';
  return resolveBaseAgentRole(normalized);
}

function buildLedgerDeveloperInstructions(
  metadata: Record<string, unknown> | undefined,
  role: ChatCodexDeveloperRole,
): string {
  const enabled = parseOptionalBoolean(metadata?.contextLedgerEnabled) ?? true;
  const agentId = parseOptionalString(metadata?.contextLedgerAgentId) ?? 'chat-codex';
  const ledgerRole = parseOptionalString(metadata?.contextLedgerRole) ?? role;
  const mode = parseOptionalString(metadata?.kernelMode) ?? parseOptionalString(metadata?.mode) ?? 'main';
  const defaultCanReadAll = role === 'router'
    ? BASE_AGENT_ROLE_CONFIG.orchestrator.defaultLedgerCanReadAll
    : BASE_AGENT_ROLE_CONFIG[role].defaultLedgerCanReadAll;
  const canReadAll = parseOptionalBoolean(metadata?.contextLedgerCanReadAll) ?? defaultCanReadAll;
  const readableAgents = Array.isArray(metadata?.contextLedgerReadableAgents)
    ? metadata.contextLedgerReadableAgents
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [];
  const focusEnabled = parseOptionalBoolean(metadata?.contextLedgerFocusEnabled) ?? true;
  const focusMaxChars = parseOptionalNumber(metadata?.contextLedgerFocusMaxChars) ?? 20_000;

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
    enabled
      ? 'Use `context_ledger.memory` for timeline query/insert when historical context is required.'
      : 'Do not call `context_ledger.memory` because ledger is disabled for this turn.',
    'Treat recalled focus as historical memory, not guaranteed latest state.',
  ];
  return lines.join('\n');
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
  const snapshot = readFingerKernelConfigSnapshot();
  if (!snapshot) {
    return inferModelContextWindowFromMetadata(metadata);
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
  return inferModelContextWindowFromMetadata(metadata);
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
  return resolveActiveProviderIdFromFingerConfig();
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
  if (/^gpt-5(\.\d+)?$/.test(normalized)) {
    return 128_000;
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
    const configPath = FINGER_PATHS.config.file.main;
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf-8');
    if (raw.trim().length === 0) return undefined;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.kernel)) return undefined;

    const kernel = parsed.kernel;
    const activeProviderId = parseOptionalString(kernel.provider);
    const providers: Record<string, FingerKernelProviderSnapshot> = {};

    if (isRecord(kernel.providers)) {
      for (const [providerId, value] of Object.entries(kernel.providers)) {
        if (!isRecord(value)) continue;
        const maxInputTokens =
          parseOptionalNumber(value.max_input_tokens)
          ?? parseOptionalNumber(value.maxInputTokens)
          ?? (isRecord(value.context_window) ? parseOptionalNumber(value.context_window.max_input_tokens) : undefined)
          ?? (isRecord(value.contextWindow) ? parseOptionalNumber(value.contextWindow.maxInputTokens) : undefined);
        providers[providerId] = {
          ...(parseOptionalString(value.model) ? { model: parseOptionalString(value.model) } : {}),
          ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
        };
      }
    }

    const globalMaxInputTokens =
      parseOptionalNumber(kernel.max_input_tokens)
      ?? parseOptionalNumber(kernel.maxInputTokens)
      ?? (isRecord(kernel.context_window) ? parseOptionalNumber(kernel.context_window.max_input_tokens) : undefined)
      ?? (isRecord(kernel.contextWindow) ? parseOptionalNumber(kernel.contextWindow.maxInputTokens) : undefined);

    return {
      ...(activeProviderId ? { activeProviderId } : {}),
      providers,
      ...(globalMaxInputTokens !== undefined ? { globalMaxInputTokens } : {}),
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

function defaultToolSpecification(name: string): ChatCodexToolSpecification {
  if (name === 'context_ledger.memory') {
    return {
      name,
      description:
        'Timeline context memory tool. Supports query/insert. For fuzzy query it checks compact memory first, then allows detailed timeline lookup.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'insert'] },
          session_id: { type: 'string' },
          agent_id: { type: 'string' },
          mode: { type: 'string' },
          since_ms: { type: 'number' },
          until_ms: { type: 'number' },
          limit: { type: 'number' },
          contains: { type: 'string' },
          fuzzy: { type: 'boolean' },
          detail: { type: 'boolean' },
          event_types: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          append: { type: 'boolean' },
          focus_max_chars: { type: 'number' },
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
};
