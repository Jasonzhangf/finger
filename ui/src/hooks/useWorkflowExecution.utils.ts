import type { InputLockState } from './useWorkflowExecution.types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function firstStringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

export function parseJsonObjectString(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function truncateInlineText(text: string, maxChars = 140): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function parseNumberLike(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.round(parsed);
      }
    }
  }
  return undefined;
}

export function estimateTokenUsage(text: string): { totalTokens: number; estimated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { totalTokens: 0, estimated: true };
  }
  const total = Math.max(1, Math.ceil(trimmed.length / 4));
  return { totalTokens: total, estimated: true };
}

export function computeContextUsagePercent(
  contextTokensInWindow: number | undefined,
  contextMaxInputTokens: number | undefined,
): number | undefined {
  if (
    typeof contextTokensInWindow !== 'number'
    || !Number.isFinite(contextTokensInWindow)
    || contextTokensInWindow < 0
    || typeof contextMaxInputTokens !== 'number'
    || !Number.isFinite(contextMaxInputTokens)
    || contextMaxInputTokens <= 0
  ) {
    return undefined;
  }
  const ratio = Math.floor((contextTokensInWindow / contextMaxInputTokens) * 100);
  return Math.max(0, Math.min(100, ratio));
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('aborted');
}

export async function safeParseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = (await response.json()) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function extractErrorMessageFromBody(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const direct = firstStringField(body, ['error', 'message']);
  if (direct) return direct;
  if (isRecord(body.result)) {
    const nested = firstStringField(body.result, ['error', 'message']);
    if (nested) return nested;
  }
  if (isRecord(body.payload)) {
    const nested = firstStringField(body.payload, ['error', 'message']);
    if (nested) return nested;
  }
  return undefined;
}

export function extractCompactSummary(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const summary = firstStringField(body, ['summary']);
  if (!summary) return undefined;
  return truncateInlineText(summary, 220);
}

export function parseRetryAfterMs(attempt: number, baseDelayMs: number): number {
  const base = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.floor(base);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function shouldRetryChatRequest(statusCode: number | undefined, errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('daily_cost_limit_exceeded')) return false;
  if (normalized.includes('insufficient_quota')) return false;
  if (normalized.includes('unauthorized')) return false;
  if (normalized.includes('forbidden')) return false;

  if (typeof statusCode === 'number') {
    return statusCode === 408
      || statusCode === 409
      || statusCode === 425
      || statusCode === 429
      || statusCode === 500
      || statusCode === 502
      || statusCode === 503
      || statusCode === 504;
  }

  return normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('result timeout')
    || normalized.includes('gateway')
    || normalized.includes('run_turn failed')
    || normalized.includes('http request failed')
    || normalized.includes('error sending request for url')
    || normalized.includes('fetch failed')
    || normalized.includes('network')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up');
}

export function extractStatusCodeFromErrorMessage(message: string): number | undefined {
  const httpMatch = message.match(/\bHTTP[_\s:]?(\d{3})\b/i);
  if (httpMatch) {
    const parsed = Number.parseInt(httpMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const statusMatch = message.match(/\bstatus[:=\s]+(\d{3})\b/i);
  if (statusMatch) {
    const parsed = Number.parseInt(statusMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function parseInputLockState(value: unknown): InputLockState | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== 'string') return null;
  const lockedBy = typeof value.lockedBy === 'string' ? value.lockedBy : null;
  const lockedAt = typeof value.lockedAt === 'string' ? value.lockedAt : null;
  const typing = value.typing === true;
  const lastHeartbeatAt = typeof value.lastHeartbeatAt === 'string' ? value.lastHeartbeatAt : null;
  const expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : null;

  return {
    sessionId: value.sessionId,
    lockedBy,
    lockedAt,
    typing,
    lastHeartbeatAt,
    expiresAt,
  };
}

export function isPersistedSessionMessageId(id: string): boolean {
  return id.startsWith('msg-');
}
