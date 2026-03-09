import { isObjectRecord } from '../common/object.js';
import { asString, firstNonEmptyString } from '../common/strings.js';
import { tryParseStructuredJson } from '../../common/structured-output.js';
import type { SessionWorkspaceDirs } from './session-workspaces.js';

export function extractSessionIdFromMessagePayload(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const direct = asString(record.sessionId);
  if (direct) return direct;
  const metadata = isObjectRecord(record.metadata) ? record.metadata : {};
  return asString(metadata.sessionId) ?? asString(metadata.session_id) ?? null;
}

export function shouldClientPersistSession(message: unknown): boolean {
  if (!isObjectRecord(message)) return false;
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const persistence = metadata.sessionPersistence ?? metadata.session_persistence ?? metadata.persistSession;
  if (persistence === false) return true;
  if (typeof persistence === 'string') {
    const normalized = persistence.trim().toLowerCase();
    return normalized === 'client' || normalized === 'ui';
  }
  return false;
}

export function extractMessageTextForSession(message: unknown): string | null {
  if (typeof message === 'string') {
    return message.trim().length > 0 ? message : null;
  }
  if (!isObjectRecord(message)) return null;
  const direct = asString(message.text)
    ?? asString(message.content)
    ?? asString(message.task)
    ?? asString(message.prompt);
  if (direct) return direct;
  if (isObjectRecord(message.message)) {
    return extractMessageTextForSession(message.message);
  }
  return null;
}

function extractSummaryFromStructuredObject(obj: Record<string, unknown>): string | null {
  // Check for common summary fields
  if (isObjectRecord(obj.params)) {
    const summary = asString(obj.params.summary)
      ?? asString(obj.params.feedback)
      ?? asString(obj.params.conclusion);
    if (summary) return summary;
  }
  if (isObjectRecord(obj.result)) {
    const nestedSummary = asString(obj.result.summary)
      ?? asString(obj.result.feedback)
      ?? asString(obj.result.conclusion);
    if (nestedSummary) return nestedSummary;
  }
  // Check direct summary fields
  const directSummary = asString(obj.summary)
    ?? asString(obj.feedback)
    ?? asString(obj.conclusion);
  if (directSummary) return directSummary;
  // Fallback to userMessage if present
  return asString(obj.userMessage) ?? null;
}

export function extractResultTextForSession(result: unknown): string | null {
  if (typeof result === 'string') {
    // Try to parse as structured JSON first
    const parseResult = tryParseStructuredJson(result);
    if (parseResult.parsed && isObjectRecord(parseResult.parsed)) {
      const summary = extractSummaryFromStructuredObject(parseResult.parsed);
      if (summary) return summary;
    }
    return result.trim().length > 0 ? result : null;
  }
  if (!isObjectRecord(result)) {
    return result === undefined ? null : JSON.stringify(result);
  }
  // Try to extract summary first
  const summary = extractSummaryFromStructuredObject(result);
  if (summary) return summary;
  // Check for nested result object
  const nested = isObjectRecord(result.result) ? result.result : null;
  if (nested) {
    const nestedSummary = extractSummaryFromStructuredObject(nested);
    if (nestedSummary) return nestedSummary;
  }
  // Fall back to existing direct fields
  const direct = asString(result.reply)
    ?? asString(result.response)
    ?? asString(result.output)
    ?? (nested ? asString(nested.reply) ?? asString(nested.response) ?? asString(nested.output) : null);
  if (direct) return direct;
  // If string field looks like JSON, try parsing for summary
  const candidateStr = asString(result.response) ?? asString(result.reply) ?? asString(result.output);
  if (candidateStr) {
    const parseResult = tryParseStructuredJson(candidateStr);
    if (parseResult.parsed && isObjectRecord(parseResult.parsed)) {
      const summary = extractSummaryFromStructuredObject(parseResult.parsed);
      if (summary) return summary;
    }
  }
  return JSON.stringify(result);
}

export function withSessionWorkspaceDefaults(
  message: unknown,
  sessionId: string | null,
  sessionWorkspaces: { resolveSessionWorkspaceDirsForMessage(sessionId: string): SessionWorkspaceDirs },
): unknown {
  if (!sessionId) return message;
  if (!isObjectRecord(message)) return message;
  const dirs = sessionWorkspaces.resolveSessionWorkspaceDirsForMessage(sessionId);
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  return {
    ...message,
    metadata: {
      ...metadata,
      ...(typeof metadata.contextLedgerRootDir === 'string' && metadata.contextLedgerRootDir.trim().length > 0
        ? {}
        : { contextLedgerRootDir: dirs.memoryDir }),
      ...(typeof metadata.deliverablesDir === 'string' && metadata.deliverablesDir.trim().length > 0
        ? {}
        : { deliverablesDir: dirs.deliverablesDir }),
      ...(typeof metadata.exchangeDir === 'string' && metadata.exchangeDir.trim().length > 0
        ? {}
        : { exchangeDir: dirs.exchangeDir }),
    },
  };
}

export function extractHttpStatusFromError(errorMessage: string): number | undefined {
  const fromHttpTag = errorMessage.match(/\bHTTP[_\s:]?(\d{3})\b/i);
  if (fromHttpTag) {
    const parsed = Number.parseInt(fromHttpTag[1], 10);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }

  const fromStatusTag = errorMessage.match(/\bstatus[:=\s]+(\d{3})\b/i);
  if (fromStatusTag) {
    const parsed = Number.parseInt(fromStatusTag[1], 10);
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 599) return parsed;
  }

  return undefined;
}

export function shouldRetryBlockingMessage(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('daily_cost_limit_exceeded')) return false;
  if (normalized.includes('insufficient_quota')) return false;
  if (normalized.includes('unauthorized')) return false;
  if (normalized.includes('forbidden')) return false;

  const inferredStatus = extractHttpStatusFromError(errorMessage);
  if (inferredStatus !== undefined) {
    return inferredStatus === 408
      || inferredStatus === 409
      || inferredStatus === 425
      || inferredStatus === 429
      || inferredStatus === 500
      || inferredStatus === 502
      || inferredStatus === 503
      || inferredStatus === 504;
  }

  return normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('gateway')
    || normalized.includes('result timeout')
    || normalized.includes('ack timeout')
    || normalized.includes('fetch failed')
    || normalized.includes('network')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up');
}

export function resolveBlockingErrorStatus(errorMessage: string): number {
  const inferred = extractHttpStatusFromError(errorMessage);
  if (inferred !== undefined) return inferred;
  if (errorMessage.includes('Timed out') || errorMessage.toLowerCase().includes('timeout')) return 504;
  return 400;
}
