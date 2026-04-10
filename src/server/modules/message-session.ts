import { isObjectRecord } from '../common/object.js';
import { asString, firstNonEmptyString } from '../common/strings.js';
import { tryParseStructuredJson } from '../../common/structured-output.js';
import type { SessionWorkspaceDirs } from './session-workspaces.js';
import { logger } from '../../core/logger.js';

const log = logger.module('message-session');

interface SessionIdExtraction {
  sessionId: string;
  source: 'payload.top' | 'metadata.sessionId' | 'metadata.session_id';
}

export function extractSessionIdFromMessagePayload(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const metadata = isObjectRecord(record.metadata) ? record.metadata : {};

  const candidates: SessionIdExtraction[] = [];
  const top = asString(record.sessionId);
  if (top) candidates.push({ sessionId: top, source: 'payload.top' });
  const metaSid = asString(metadata.sessionId);
  if (metaSid) candidates.push({ sessionId: metaSid, source: 'metadata.sessionId' });
  const metaUnderscore = asString(metadata.session_id);
  if (metaUnderscore) candidates.push({ sessionId: metaUnderscore, source: 'metadata.session_id' });

  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    const unique = new Set(candidates.map(c => c.sessionId));
    if (unique.size > 1) {
      const detail = candidates.map(c => `${c.source}=${c.sessionId}`).join(', ');
      log.error('sessionId conflict in message payload', new Error(detail));
      throw new Error(`Conflicting sessionId sources: ${detail}. Use exactly one.`);
    }
  }

  if (metaSid) {
    log.info('sessionId extracted from payload', { source: 'metadata.sessionId', sessionId: metaSid });
    return metaSid;
  }

  const chosen = candidates[0];
  log.info('sessionId extracted from payload', { source: chosen.source, sessionId: chosen.sessionId });
  return chosen.sessionId;
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

export function extractKernelMetadataFromAgentResult(result: unknown): Record<string, unknown> | undefined {
  const candidates: unknown[] = [result];
  if (isObjectRecord(result)) {
    candidates.push(result.rawPayload);
    if (isObjectRecord(result.result)) {
      candidates.push(result.result);
      candidates.push(result.result.rawPayload);
      if (isObjectRecord(result.result.result)) {
        candidates.push(result.result.result);
        candidates.push(result.result.result.rawPayload);
      }
    }
  }
  for (const candidate of candidates) {
    if (!isObjectRecord(candidate)) continue;
    if (isObjectRecord(candidate.metadata)) {
      return candidate.metadata;
    }
  }
  return undefined;
}

export function kernelMetadataHasCompactedProjection(metadata: Record<string, unknown> | undefined): boolean {
  if (!isObjectRecord(metadata)) return false;
  const compact = isObjectRecord(metadata.compact) ? metadata.compact : {};
  if (compact.applied === true) return true;
  const apiHistory = Array.isArray(metadata.api_history) ? metadata.api_history : [];
  return apiHistory.some((item) => {
    if (!isObjectRecord(item)) return false;
    const content = extractKernelHistoryContent(item);
    if (!content) return false;
    const normalized = content.trim().toLowerCase();
    return normalized.includes('<task_digest>') || normalized.includes('<history_summary>');
  });
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
  // ledger root_dir: kernel builds path as {root_dir}/{session_id}/{agent_id}/{mode}/context-ledger.jsonl
  const ledgerRootDir = inferLedgerRootDir(dirs.memoryDir);
  return {
    ...message,
    metadata: {
      ...metadata,
      ...(typeof metadata.contextLedgerRootDir === 'string' && metadata.contextLedgerRootDir.trim().length > 0
        ? {}
        : { contextLedgerRootDir: ledgerRootDir }),
      ...(typeof metadata.deliverablesDir === 'string' && metadata.deliverablesDir.trim().length > 0
        ? {}
        : { deliverablesDir: dirs.deliverablesDir }),
      ...(typeof metadata.exchangeDir === 'string' && metadata.exchangeDir.trim().length > 0
        ? {}
        : { exchangeDir: dirs.exchangeDir }),
    },
  };
}

function extractKernelHistoryContent(item: Record<string, unknown>): string {
  const direct = asString(item.output_text)
    ?? (typeof item.content === 'string' ? item.content : null);
  if (direct) return direct;
  if (!Array.isArray(item.content)) return '';
  return item.content
    .flatMap((entry) => {
      if (!isObjectRecord(entry)) return [];
      const text = asString(entry.text) ?? asString(entry.content);
      return text ? [text] : [];
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n');
}

function inferLedgerRootDir(memoryDir: string): string {
  // memoryDir: /Users/x/.finger/system/sessions/{sid}/workspace/memory
  // root_dir should be: /Users/x/.finger/system/sessions
  const parts = memoryDir.split('/');
  const sessionsIdx = parts.lastIndexOf('sessions');
  if (sessionsIdx > 0) {
    return parts.slice(0, sessionsIdx + 1).join('/');
  }
  const workspaceIdx = parts.lastIndexOf('workspace');
  if (workspaceIdx > 0) {
    return parts.slice(0, workspaceIdx).join('/');
  }
  return memoryDir;
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
