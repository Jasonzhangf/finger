/**
 * Reasoning Module - 模块主文件（新文件）
 * 
 * 这是 reasoning 模块的主入口文件。
 * 逐步从 chat-codex-module.ts 迁移内容。
 */
import { join } from 'path';
import { FINGER_PATHS, ensureDir, normalizeSessionDirName } from '../../core/finger-paths.js';

import type {
  ReasoningRoleProfile,
  ReasoningToolSpec,
  ReasoningToolExecutionConfig,
  ReasoningModuleConfig,
  ReasoningResult,
  ReasoningLoopEvent,
  ReasoningKernelEvent,
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
