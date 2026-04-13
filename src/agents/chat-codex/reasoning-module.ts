import type { ChatCodexDeveloperRole as DeveloperRole } from './developer-prompt-templates.js';
/**
 * Reasoning Module - 模块主文件（新文件）
 * 
 * 这是 reasoning 模块的主入口文件。
 * 逐步从 chat-codex-module.ts 迁移内容。
 */
import type { MailboxSnapshot } from '../../runtime/mailbox-snapshot.js';
import { join } from 'path';
import { estimateTokensWithTiktoken } from '../../utils/tiktoken-estimator.js';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../../core/finger-paths.js';

import { existsSync, readdirSync, readFileSync } from 'fs';
import { FINGER_SOURCE_ROOT } from '../../core/source-root.js';
import { loadAIProviders, getContextWindow } from '../../core/user-settings.js';
import type {
  ReasoningRoleProfile,
  ReasoningToolSpec,
  ReasoningToolExecutionConfig,
  ReasoningModuleConfig,
  ReasoningResult,
  ReasoningLoopEvent,
  ReasoningKernelEvent,
  ReasoningKernelRawEvent,
  ReasoningKernelInputItem,
  ReasoningContext,
  ReasoningRunner,
  ReasoningInputItem,
  ReasoningSessionState,
  ReasoningInterruptResult,
  ReasoningToolTrace,
  ReasoningRoundTrace,
} from './reasoning-types.js';
import { BASE_AGENT_ROLE_CONFIG } from './agent-role-config.js';
import { getFingerAppVersion } from '../../core/app-version.js';
import { logger } from '../../core/logger/index.js';

// ==================== 常量配置 ====================

const DEFAULT_KERNEL_TIMEOUT_MS = 120_000;
const DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT = 3;
const DEFAULT_KERNEL_STALL_TIMEOUT_MS = 600_000;
const ACTIVE_TURN_STALE_GRACE_MS = 15_000;
const FLOW_PROMPT_MAX_CHARS = 10_000;
const USER_PROFILE_PROMPT_MAX_CHARS = 8_000;
const AGENTS_PROMPT_MAX_FILES = 4;
const AGENTS_PROMPT_MAX_CHARS_PER_FILE = 4_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 262_144;
const reasoningLog = logger.module('ReasoningModule');

// ==================== 工具白名单 ====================

export const REASONING_ORCHESTRATOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_EXECUTOR_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_SEARCHER_ALLOWED_TOOLS = [
  ...BASE_AGENT_ROLE_CONFIG.project.allowedTools,
];
export const REASONING_RESEARCHER_ALLOWED_TOOLS = REASONING_SEARCHER_ALLOWED_TOOLS;
export const REASONING_CODER_ALLOWED_TOOLS = REASONING_EXECUTOR_ALLOWED_TOOLS;
export const REASONING_CODING_CLI_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const REASONING_PROJECT_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const REASONING_SYSTEM_ALLOWED_TOOLS = [...BASE_AGENT_ROLE_CONFIG.system.allowedTools];

// 兼容性别名（旧命名）
export const CHAT_CODEX_ORCHESTRATOR_ALLOWED_TOOLS = REASONING_ORCHESTRATOR_ALLOWED_TOOLS;
export const CHAT_CODEX_EXECUTOR_ALLOWED_TOOLS = REASONING_EXECUTOR_ALLOWED_TOOLS;
export const CHAT_CODEX_SEARCHER_ALLOWED_TOOLS = REASONING_SEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_RESEARCHER_ALLOWED_TOOLS = REASONING_RESEARCHER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODER_ALLOWED_TOOLS = REASONING_CODER_ALLOWED_TOOLS;
export const CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS = REASONING_CODING_CLI_ALLOWED_TOOLS;
export const CHAT_CODEX_PROJECT_ALLOWED_TOOLS = REASONING_PROJECT_ALLOWED_TOOLS;
export const CHAT_CODEX_SYSTEM_ALLOWED_TOOLS = REASONING_SYSTEM_ALLOWED_TOOLS;

// ==================== Runner 框架 ====================

// TODO: finger-299.3 将逐步迁移 chat-codex-module.ts 内容到此文件

export class ProcessReasoningRunner implements ReasoningRunner {
  async runTurn(text: string, items?: ReasoningInputItem[], context?: ReasoningContext): Promise<ReasoningResult> {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    throw new Error('Not implemented - will be migrated from chat-codex-module.ts');
  }

  async interrupt(sessionId: string): Promise<ReasoningInterruptResult | null> {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    throw new Error('Not implemented - will be migrated from chat-codex-module.ts');
  }

  getSessionState(sessionId: string): ReasoningSessionState | null {
    // TODO: 实现逻辑（从 chat-codex-module.ts 迁移）
    return null;
  }
}

// 临时导出旧模块别名（兼容性）
export { ProcessReasoningRunner as ProcessChatCodexRunner };

// ==================== 辅助函数 ====================

function safeNotifyLoopEvent(
  callback: ReasoningModuleConfig['onLoopEvent'],
  event: ReasoningLoopEvent,
): void {
  if (!callback) return;
  void Promise.resolve(callback(event)).catch((error) => {
    reasoningLog.warn('Loop event callback failed', {
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

export function isRetryableReasoningError(error: unknown): boolean {
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

// 兼容性别名
export const isRetryableRunError = isRetryableReasoningError;

function retryDelayMs(attempt: number): number {
  if (process.env.NODE_ENV === 'test') return 0;
  const clampedAttempt = Math.max(1, attempt);
  return Math.min(30_000, Math.floor(750 * Math.pow(2, clampedAttempt - 1)));
}

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: ReasoningModuleConfig = {
  id: 'reasoning',
  name: 'Reasoning Bridge',
  version: getFingerAppVersion(),
  timeoutMs: DEFAULT_KERNEL_TIMEOUT_MS,
  timeoutRetryCount: DEFAULT_KERNEL_TIMEOUT_RETRY_COUNT,
};

// ==================== 类型辅助函数 ====================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ==================== 路径处理函数 ====================

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

// ==================== Kernel Metadata 解析 ====================

function parseKernelMetadata(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// ==================== Kernel Trace 提取函数 ====================

function extractKernelToolTrace(metadata: Record<string, unknown>): ReasoningToolTrace[] {
  const raw = metadata.tool_trace;
  if (!Array.isArray(raw)) return [];

  const result: ReasoningToolTrace[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
    if (!tool) continue;
    const status: ReasoningToolTrace['status'] = item.status === 'error' ? 'error' : 'ok';
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

function extractKernelRoundTrace(metadata: Record<string, unknown>): ReasoningRoundTrace[] {
  const raw = metadata.round_trace;
  if (!Array.isArray(raw)) return [];

  const result: ReasoningRoundTrace[] = [];
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
      && item.context_usage_percent <= 100
        ? Math.round(item.context_usage_percent * 10) / 10
        : undefined;
    const maxInputTokens =
      typeof item.max_input_tokens === 'number'
      && Number.isFinite(item.max_input_tokens)
      && item.max_input_tokens >= 0
        ? Math.floor(item.max_input_tokens)
        : undefined;
    const thresholdPercent =
      typeof item.threshold_percent === 'number'
      && Number.isFinite(item.threshold_percent)
      && item.threshold_percent >= 0
      && item.threshold_percent <= 100
        ? Math.round(item.threshold_percent * 10) / 10
        : undefined;

    result.push({
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

// ==================== Runner 辅助函数 ====================

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

function parseOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveRunnerProviderId(context?: ReasoningContext): string {
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
  const distBin = join(FINGER_SOURCE_ROOT, 'dist', 'bin', 'kernel-bridge');
  if (existsSync(distBin)) return distBin;
  const rustTarget = join(FINGER_SOURCE_ROOT, 'rust', 'target', 'release', 'kernel-bridge');
  if (existsSync(rustTarget)) return rustTarget;
  // Fallback to relative path
  return join(FINGER_SOURCE_ROOT, 'dist', 'bin', 'kernel-bridge');
}

// ==================== Kernel Event 解析 ====================

function parseKernelEvent(line: string): ReasoningKernelRawEvent | null {
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

  const event: ReasoningKernelRawEvent = {
    id: parsed.id,
    msg: {
      type: parsed.msg.type,
    },
  };

  return event;
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

function parseKernelInputItems(metadata?: Record<string, unknown>): ReasoningKernelInputItem[] | undefined {
  if (!metadata) return undefined;
  const raw = metadata.input_items;
  if (!Array.isArray(raw)) return undefined;
  const result: ReasoningKernelInputItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = parseOptionalString(item.type);
    if (type === 'text') {
      const text = parseOptionalString(item.text);
      if (text) result.push({ type: 'text', text });
    } else if (type === 'image') {
      const imageUrl = parseOptionalString(item.image_url);
      if (imageUrl) result.push({ type: 'image', image_url: imageUrl });
    }
  }
  return result.length > 0 ? result : undefined;
}

function normalizeKernelInputItems(items: ReasoningKernelInputItem[] | undefined, fallbackText: string): ReasoningKernelInputItem[] {
  if (items && items.length > 0) return items;
  return [{ type: 'text', text: fallbackText }];
}

function isSystemControlTurn(metadata: Record<string, unknown> | undefined): boolean {
  if (!isRecord(metadata)) return false;
  const turnType = parseOptionalString(metadata.turn_type);
  return turnType === 'system_control';
}

function appendPromptSection(base: string | undefined, section: string | undefined): string | undefined {
  if (!section || section.trim().length === 0) return base;
  if (!base || base.trim().length === 0) return section;
  return `${base}\n\n${section}`;
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

function isProjectLikeAgent(metadata: Record<string, unknown> | undefined): boolean {
  if (!isRecord(metadata)) return false;
  const agentId = parseOptionalString(metadata.agentId);
  if (!agentId) return false;
  const normalized = agentId.toLowerCase();
  return normalized.includes('project') || normalized.includes('general');
}

function normalizeAbsoluteDir(rawPath: string | undefined): string | undefined {
  if (!rawPath || rawPath.trim().length === 0) return undefined;
  return rawPath.trim();
}

function isSameOrSubPath(candidate: string, root: string): boolean {
  if (!candidate || !root) return false;
  const normalizedCandidate = candidate.replace(/\/+/g, '/');
  const normalizedRoot = root.replace(/\/+/g, '/');
  if (normalizedCandidate === normalizedRoot) return true;
  if (normalizedCandidate.startsWith(normalizedRoot + '/')) return true;
  return false;
}

function collectApplicableAgentsFiles(startDir: string, projectRoot?: string): string[] {
  const result: string[] = [];
  try {
    const entries = readdirSync(startDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(startDir, entry.name);
      const agentsFile = join(subDir, 'AGENTS.md');
      if (existsSync(agentsFile)) {
        if (!projectRoot || isSameOrSubPath(subDir, projectRoot)) {
          result.push(agentsFile);
        }
      }
      // Recursively search subdirectories
      const subResult = collectApplicableAgentsFiles(subDir, projectRoot);
      if (subResult.length > 0) {
        result.push(...subResult);
      }
    }
  } catch {
    // Ignore errors
  }
  return result;
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
  inputItems: ReasoningKernelInputItem[] | undefined,
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

function inferModelContextWindowFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  const modelFromMetadata =
    parseOptionalString(metadata?.model)
    ?? parseOptionalString(metadata?.kernelModel)
    ?? parseOptionalString(metadata?.model_name);
  if (modelFromMetadata) {
    const inferred = inferModelContextWindow(modelFromMetadata);
    if (inferred !== undefined) return inferred;
  }
  return undefined;
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

function normalizeDeveloperRole(role: string): DeveloperRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'system') return 'system';
  return 'project';
}

function mapDeveloperRoleToPromptAgentType(role: DeveloperRole): string {
  return role;
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
