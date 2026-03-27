/**
 * Dispatch Helpers
 * Extracted from dispatch.ts to stay under 500-line limit.
 */
import * as path from 'path';

import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
import { sanitizeDispatchResult, type DispatchSummaryResult } from '../../../common/agent-dispatch.js';
import { inferTagsAndTopic } from '../../../common/tag-topic-inference.js';
import type { AgentDispatchRequest } from './types.js';
export function resolveDispatchSessionStrategy(input: AgentDispatchRequest): NonNullable<AgentDispatchRequest['sessionStrategy']> {

  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const raw = firstNonEmptyString(
    input.sessionStrategy,
    asString(metadata.sessionStrategy),
    asString(metadata.session_strategy),
    asString(metadata.sessionMode),
    asString(metadata.session_mode),
  );
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'latest') return 'latest';
  if (normalized === 'new') return 'new';
  if (normalized === 'current') return 'current';
  return 'latest';
}

export function formatLocalTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const offset = -date.getTimezoneOffset();
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const offsetSign = offset >= 0 ? '+' : '-';
  return year + '-' + month + '-' + day + ' ' + hours + ':' + minutes + ':' + seconds + '.' + ms + ' ' + offsetSign + offsetHours + ':' + offsetMinutes;
}

export function normalizeProjectPathHint(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  const expanded = trimmed.startsWith('~/')
    ? path.join(process.env.HOME || '', trimmed.slice(2))
    : trimmed;
  return path.resolve(expanded);
}
export function formatDispatchTaskContent(task: unknown): string {
  if (typeof task === 'string') return task;
  if (!isObjectRecord(task)) return String(task);
  const direct = asString(task.text)
    ?? asString(task.content)
    ?? asString(task.prompt)
    ?? asString(task.description)
    ?? asString(task.title)
    ?? asString(task.task)
    ?? asString(task.message);
  if (direct) return direct;
  if (isObjectRecord(task.input)) {
    const nested = asString(task.input.text)
      ?? asString(task.input.content)
      ?? asString(task.input.prompt)
      ?? asString(task.input.description);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(task, null, 2);
  } catch {
    return String(task);
  }
}

export function enrichDispatchTagsAndTopic(
  result: DispatchSummaryResult,
  params: {
    task: unknown;
    targetAgentId: string;
    sourceAgentId?: string;
  },
): DispatchSummaryResult {
  const inferred = inferTagsAndTopic({
    texts: [
      formatDispatchTaskContent(params.task),
      result.summary,
      result.error,
      result.nextAction,
      result.status,
    ],
    seedTags: [
      params.targetAgentId,
      params.sourceAgentId ?? '',
      result.success ? 'completed' : 'failed',
      'dispatch',
      ...(result.tags ?? []),
    ],
    seedTopic: result.topic,
    maxTags: 10,
  });

  return {
    ...result,
    ...(inferred.tags ? { tags: inferred.tags } : {}),
    ...(inferred.topic ? { topic: inferred.topic } : {}),
  };
}
