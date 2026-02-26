import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import type { OutputModule } from '../../orchestration/module-registry.js';
import { KernelAgentBase, type KernelAgentRunner } from '../base/kernel-agent-base.js';
import { resolveCodingCliSystemPrompt } from './coding-cli-system-prompt.js';

const DEFAULT_KERNEL_TIMEOUT_MS = 120_000;
export const CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS = [
  'shell.exec',
  'exec_command',
  'write_stdin',
  'apply_patch',
  'view_image',
  'update_plan',
];

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
  binaryPath?: string;
  codingPromptPath?: string;
  resolveToolSpecifications?: (toolNames: string[]) => Promise<ChatCodexToolSpecification[]> | ChatCodexToolSpecification[];
  toolExecution?: ChatCodexToolExecutionConfig;
  onLoopEvent?: (event: ChatCodexLoopEvent) => void | Promise<void>;
}

export interface ChatCodexRunResult {
  reply: string;
  events: KernelEvent[];
  usedBinaryPath: string;
  kernelMetadata?: Record<string, unknown>;
}

export interface ChatCodexLoopEvent {
  sessionId: string;
  phase: 'turn_start' | 'kernel_event' | 'turn_complete' | 'turn_error';
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface ChatCodexRunContext {
  sessionId?: string;
  systemPrompt?: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  metadata?: Record<string, unknown>;
  tools?: ChatCodexToolSpecification[];
  toolExecution?: ChatCodexToolExecutionConfig;
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

interface KernelEvent {
  id: string;
  msg: {
    type: string;
    last_agent_message?: string;
    message?: string;
    metadata_json?: string;
  };
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

export class ProcessChatCodexRunner implements ChatCodexRunner {
  private readonly timeoutMs: number;
  private readonly binaryPath?: string;
  private readonly toolExecution?: ChatCodexToolExecutionConfig;

  constructor(options: Pick<ChatCodexModuleConfig, 'timeoutMs' | 'binaryPath' | 'toolExecution'>) {
    this.timeoutMs = options.timeoutMs;
    this.binaryPath = options.binaryPath;
    this.toolExecution = options.toolExecution;
  }

  async runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
    const resolvedPath = resolveKernelBinaryPath(this.binaryPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`kernel bridge binary not found: ${resolvedPath}`);
    }

    const normalizedItems = normalizeKernelInputItems(items, text);
    const options = buildKernelUserTurnOptions(context, this.toolExecution);

    return new Promise<ChatCodexRunResult>((resolve, reject) => {
      const child = spawn(resolvedPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      const events: KernelEvent[] = [];
      let stderrBuffer = '';
      let replyText: string | undefined;
      let kernelMetadata: Record<string, unknown> | undefined;
      let settled = false;
      let shutdownSent = false;

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const sendSubmission = (submission: unknown): void => {
        if (!child.stdin.writable) return;
        child.stdin.write(`${JSON.stringify(submission)}\n`);
      };

      const sendShutdown = (): void => {
        if (shutdownSent) return;
        shutdownSent = true;
        sendSubmission({ id: 'bye', op: { type: 'shutdown' } });
        child.stdin.end();
      };

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        settle(() => reject(new Error(`chat-codex timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      const stdoutLines = createInterface({ input: child.stdout });
      stdoutLines.on('line', (line: string) => {
        const parsed = parseKernelEvent(line);
        if (!parsed) return;

        events.push(parsed);
        const eventType = parsed.msg.type;

        if (parsed.id === 'u1' && eventType === 'error') {
          sendShutdown();
          const errorMessage = parsed.msg.message ?? 'chat-codex kernel error';
          settle(() => reject(new Error(errorMessage)));
          return;
        }

        if (parsed.id === 'u1' && eventType === 'task_complete') {
          if (parsed.msg.last_agent_message && parsed.msg.last_agent_message.trim().length > 0) {
            replyText = parsed.msg.last_agent_message;
          }
          if (parsed.msg.metadata_json && parsed.msg.metadata_json.trim().length > 0) {
            kernelMetadata = parseKernelMetadata(parsed.msg.metadata_json);
          }
          sendShutdown();
          return;
        }

        if (eventType === 'shutdown_complete') {
          const finalReply = replyText;
          if (!finalReply) {
            settle(() => reject(new Error('chat-codex got empty model reply')));
            return;
          }

          settle(() => {
            resolve({
              reply: finalReply,
              events,
              usedBinaryPath: resolvedPath,
              ...(kernelMetadata ? { kernelMetadata } : {}),
            });
          });
        }
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (error: Error) => {
        settle(() => reject(error));
      });

      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        const status = code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`;
        const stderrMessage = stderrBuffer.trim();
        const detail = stderrMessage.length > 0 ? `; stderr: ${stderrMessage}` : '';
        settle(() => reject(new Error(`chat-codex process exited with ${status}${detail}`)));
      });

      sendSubmission({
        id: 'u1',
        op: {
          type: 'user_turn',
          items: normalizedItems,
          ...(options ? { options } : {}),
        },
      });
    });
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
  const activeRunner =
    runner ??
    new ProcessChatCodexRunner({
      timeoutMs: mergedConfig.timeoutMs,
      binaryPath: mergedConfig.binaryPath,
      toolExecution: mergedConfig.toolExecution,
    });

  const kernelRunner: KernelAgentRunner = {
    runTurn: async (text: string, context) => {
      const inputItems = parseKernelInputItems(context?.metadata);
      const sessionId = context?.sessionId ?? 'unknown';
      const toolSpecifications = await resolveToolSpecifications(context?.tools, mergedConfig.resolveToolSpecifications);

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_start',
        timestamp: new Date().toISOString(),
        payload: {
          text,
          inputItemCount: inputItems?.length ?? 0,
          inputTypes: (inputItems ?? []).map((item) => item.type),
          toolCount: toolSpecifications.length,
        },
      });

      let runResult: ChatCodexRunResult;
      try {
        runResult = await activeRunner.runTurn(text, inputItems, {
          sessionId,
          systemPrompt: context?.systemPrompt,
          history: context?.history,
          metadata: context?.metadata,
          tools: toolSpecifications,
          toolExecution: mergedConfig.toolExecution,
        });
      } catch (error) {
        safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
          sessionId,
          phase: 'turn_error',
          timestamp: new Date().toISOString(),
          payload: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        throw error;
      }

      for (const event of runResult.events) {
        safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
          sessionId,
          phase: 'kernel_event',
          timestamp: new Date().toISOString(),
          payload: {
            id: event.id,
            type: event.msg.type,
            ...(event.msg.message ? { message: event.msg.message } : {}),
            ...(event.msg.last_agent_message ? { lastAgentMessage: event.msg.last_agent_message } : {}),
          },
        });
      }

      safeNotifyLoopEvent(mergedConfig.onLoopEvent, {
        sessionId,
        phase: 'turn_complete',
        timestamp: new Date().toISOString(),
        payload: {
          replyPreview: runResult.reply.slice(0, 300),
          eventCount: runResult.events.length,
          finalKernelEvent: runResult.events.length > 0 ? runResult.events[runResult.events.length - 1].msg.type : null,
        },
      });

      return {
        reply: runResult.reply,
        metadata: {
          binaryPath: runResult.usedBinaryPath,
          eventCount: runResult.events.length,
          kernelEventTypes: runResult.events.map((event) => event.msg.type),
          stopReason: 'model_stop',
          ...(runResult.kernelMetadata ?? {}),
        },
      };
    },
  };

  const kernelAgent = new KernelAgentBase(
    {
      moduleId: mergedConfig.id,
      provider: 'codex',
      defaultSystemPromptResolver: resolveCodingPrompt,
      defaultRoleProfileId: 'coding-cli',
      maxContextMessages: 20,
      roleProfiles: {
        'coding-cli': {
          id: 'coding-cli',
          systemPromptResolver: resolveCodingPrompt,
          allowedTools: CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS,
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
    },
    handle: async (message: unknown, callback?: (result: unknown) => void): Promise<unknown> => {
      const response = (await kernelAgent.handle(message)) as ChatCodexResponse;
      if (callback) callback(response);
      return response;
    },
  };
}

function parseKernelEvent(line: string): KernelEvent | null {
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

  const event: KernelEvent = {
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

  return event;
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
): KernelUserTurnOptions | undefined {
  const options: KernelUserTurnOptions = {};
  const metadata = context?.metadata;

  if (context?.systemPrompt && context.systemPrompt.trim().length > 0) {
    options.system_prompt = context.systemPrompt.trim();
    options.user_instructions = context.systemPrompt.trim();
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
    !options.user_instructions &&
    !options.environment_context &&
    !options.turn_context &&
    !options.context_window &&
    !options.compact &&
    !options.fork_user_message_index &&
    !options.tools &&
    !options.tool_execution
  ) {
    return undefined;
  }

  return options;
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
    `approval=${turnContext.approval ?? 'never'}`,
    `sandbox=${turnContext.sandbox ?? 'danger-full-access'}`,
    `shell=${process.env.SHELL ?? 'unknown'}`,
  ];
  if (turnContext.model) lines.push(`model=${turnContext.model}`);
  return lines.join('\n');
}

function resolveContextWindow(
  metadata: Record<string, unknown> | undefined,
): KernelUserTurnOptions['context_window'] | undefined {
  const maxInputTokens = parseOptionalNumber(metadata?.maxInputTokens);
  const baselineTokens = parseOptionalNumber(metadata?.baselineTokens);
  const thresholdRatio = parseOptionalNumber(metadata?.autoCompactThresholdRatio);

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

    if (sanitized.length > 0) return sanitized;
  } catch {
    // noop, fallback below
  }

  return normalizedNames.map((name) => ({
    name,
    description: `Execute ${name}`,
    inputSchema: { type: 'object', additionalProperties: true },
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
