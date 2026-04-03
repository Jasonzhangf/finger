import { writeFileSync } from 'fs';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { logger } from '../../core/logger.js';
import {
  mergeProjectTaskState,
  parseDelegatedProjectTaskRegistry,
  parseProjectTaskState,
  pruneDelegatedRegistryForContextAfterTaskClosed,
  shouldArchiveAndClearProjectTaskState,
  type DelegatedProjectTaskRecord,
  type ProjectTaskLifecycleStatus,
  type ProjectTaskState,
  upsertDelegatedProjectTaskRegistry,
} from '../../common/project-task-state.js';
import { appendClosedProjectTaskArchive } from '../../core/project-task-archive.js';

const log = logger.module('ProjectStatusGateway');
const BLOCKED_BY_NONE = 'none';
const STALE_MS_DEFAULT = 120_000;
const EVENT_DEDUP_TTL_MS = 10 * 60_000;
const eventDedupTsByKey = new Map<string, number>();

const ACTIVE_STATUSES: Set<ProjectTaskLifecycleStatus> = new Set([
  'create',
  'dispatched',
  'accepted',
  'in_progress',
  'claiming_finished',
  'reviewed',
  'reported',
  'blocked',
]);

const TRANSITION_MAP: Record<ProjectTaskLifecycleStatus, Set<ProjectTaskLifecycleStatus>> = {
  create: new Set(['dispatched', 'accepted', 'in_progress', 'blocked', 'failed', 'cancelled', 'closed', 'create']),
  dispatched: new Set(['accepted', 'in_progress', 'blocked', 'failed', 'cancelled', 'closed', 'dispatched']),
  accepted: new Set(['in_progress', 'blocked', 'failed', 'cancelled', 'closed', 'accepted']),
  in_progress: new Set(['claiming_finished', 'blocked', 'failed', 'cancelled', 'closed', 'in_progress']),
  claiming_finished: new Set(['reviewed', 'in_progress', 'blocked', 'failed', 'cancelled', 'closed', 'claiming_finished']),
  reviewed: new Set(['reported', 'in_progress', 'blocked', 'failed', 'cancelled', 'closed', 'reviewed']),
  reported: new Set(['closed', 'in_progress', 'blocked', 'failed', 'cancelled', 'reported']),
  closed: new Set(['closed']),
  blocked: new Set(['in_progress', 'dispatched', 'accepted', 'failed', 'cancelled', 'closed', 'blocked']),
  failed: new Set(['in_progress', 'cancelled', 'closed', 'failed']),
  cancelled: new Set(['cancelled']),
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBlockedBy(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/).map((item) => item.trim())
      : [];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const normalized = Array.from(new Set(
    list
      .map((item) => asTrimmedString(item))
      .filter((item) => item.length > 0),
  ));
  if (normalized.length === 0) return undefined;
  const hasNone = normalized.some((item) => item.toLowerCase() === BLOCKED_BY_NONE);
  const hasDeps = normalized.some((item) => item.toLowerCase() !== BLOCKED_BY_NONE);
  if (hasNone && hasDeps) return undefined;
  return hasNone ? [BLOCKED_BY_NONE] : normalized;
}

function hasExplicitBlockedByInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return false;
}

function normalizeRevision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 1 ? normalized : undefined;
}

function isSemanticNoopPatch(current: ProjectTaskState | null, next: ProjectTaskState): boolean {
  if (!current) return false;
  return (
    current.active === next.active
    && current.status === next.status
    && (current.taskId ?? '') === (next.taskId ?? '')
    && (current.taskName ?? '') === (next.taskName ?? '')
    && (current.dispatchId ?? '') === (next.dispatchId ?? '')
    && (current.boundSessionId ?? '') === (next.boundSessionId ?? '')
    && (current.summary ?? '') === (next.summary ?? '')
    && (current.note ?? '') === (next.note ?? '')
    && (current.assignerName ?? '') === (next.assignerName ?? '')
    && (current.assigneeWorkerId ?? '') === (next.assigneeWorkerId ?? '')
    && (current.assigneeWorkerName ?? '') === (next.assigneeWorkerName ?? '')
    && (current.deliveryWorkerId ?? '') === (next.deliveryWorkerId ?? '')
    && (current.deliveryWorkerName ?? '') === (next.deliveryWorkerName ?? '')
    && (current.reviewerId ?? '') === (next.reviewerId ?? '')
    && (current.reviewerName ?? '') === (next.reviewerName ?? '')
    && (current.reassignReason ?? '') === (next.reassignReason ?? '')
    && JSON.stringify(current.blockedBy ?? []) === JSON.stringify(next.blockedBy ?? [])
  );
}

function validateTransition(
  current: ProjectTaskState | null,
  next: ProjectTaskState,
): { ok: true } | { ok: false; error: string } {
  if (!current) return { ok: true };
  const allowed = TRANSITION_MAP[current.status] ?? new Set<ProjectTaskLifecycleStatus>([current.status]);
  if (!allowed.has(next.status)) {
    return {
      ok: false,
      error: `invalid status transition: ${current.status} -> ${next.status}`,
    };
  }
  const currentRevision = normalizeRevision(current.revision) ?? 1;
  const nextRevision = normalizeRevision(next.revision);
  if (nextRevision !== undefined && nextRevision < currentRevision) {
    return {
      ok: false,
      error: `revision regression: current=${currentRevision}, next=${nextRevision}`,
    };
  }
  if ((next.status === 'create' || next.status === 'dispatched' || next.status === 'accepted') && !next.taskId && !next.taskName) {
    return {
      ok: false,
      error: `task identity missing for status=${next.status}`,
    };
  }
  return { ok: true };
}

function writeTaskRouterMarkdown(
  projectPath: string,
  state: ProjectTaskState,
  registry: DelegatedProjectTaskRecord[],
): void {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) return;
  const normalized = projectPath.replace(/\/+$/, '');
  const taskFilePath = `${normalized}/TASK.md`;
  const nowIso = new Date().toISOString();
  const lines: string[] = [
    '# TASK Router',
    '',
    `Updated: ${nowIso}`,
    '',
    '## Current Task State',
    `- active: ${state.active}`,
    `- status: ${state.status}`,
    `- source: ${state.sourceAgentId}`,
    `- target: ${state.targetAgentId}`,
    state.assignerName ? `- assignerName: ${state.assignerName}` : '- assignerName: N/A',
    state.assigneeWorkerId ? `- assigneeWorkerId: ${state.assigneeWorkerId}` : '- assigneeWorkerId: N/A',
    state.assigneeWorkerName ? `- assigneeWorkerName: ${state.assigneeWorkerName}` : '- assigneeWorkerName: N/A',
    state.deliveryWorkerId ? `- deliveryWorkerId: ${state.deliveryWorkerId}` : '- deliveryWorkerId: N/A',
    state.deliveryWorkerName ? `- deliveryWorkerName: ${state.deliveryWorkerName}` : '- deliveryWorkerName: N/A',
    state.reviewerId ? `- reviewerId: ${state.reviewerId}` : '- reviewerId: N/A',
    state.reviewerName ? `- reviewerName: ${state.reviewerName}` : '- reviewerName: N/A',
    state.reassignReason ? `- reassignReason: ${state.reassignReason}` : '- reassignReason: N/A',
    state.taskId ? `- taskId: ${state.taskId}` : '- taskId: N/A',
    state.taskName ? `- taskName: ${state.taskName}` : '- taskName: N/A',
    state.dispatchId ? `- dispatchId: ${state.dispatchId}` : '- dispatchId: N/A',
    state.boundSessionId ? `- boundSessionId: ${state.boundSessionId}` : '- boundSessionId: N/A',
    typeof state.revision === 'number' ? `- revision: ${state.revision}` : '- revision: N/A',
    state.blockedBy && state.blockedBy.length > 0
      ? `- blocked_by: ${state.blockedBy.join(', ')}`
      : '- blocked_by: none',
    state.note ? `- note: ${state.note}` : '- note: N/A',
    '',
    '## Delegated Project List (latest)',
  ];
  const ordered = [...registry]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20);
  if (ordered.length === 0) {
    lines.push('- (empty)');
  } else {
    for (const item of ordered) {
      lines.push(
        `- [${item.status}] active=${item.active} target=${item.targetAgentId}`
        + `${item.assignerName ? ` assigner=${item.assignerName}` : ''}`
        + `${item.assigneeWorkerId ? ` assignee=${item.assigneeWorkerId}` : ''}`
        + `${item.assigneeWorkerName ? ` assigneeName=${item.assigneeWorkerName}` : ''}`
        + `${item.deliveryWorkerId ? ` delivery=${item.deliveryWorkerId}` : ''}`
        + `${item.deliveryWorkerName ? ` deliveryName=${item.deliveryWorkerName}` : ''}`
        + `${item.reviewerId ? ` reviewer=${item.reviewerId}` : ''}`
        + `${item.reviewerName ? ` reviewerName=${item.reviewerName}` : ''}`
        + `${item.reassignReason ? ` reassign_reason=${item.reassignReason}` : ''}`
        + `${item.taskId ? ` taskId=${item.taskId}` : ''}`
        + `${item.taskName ? ` task="${item.taskName}"` : ''}`
        + `${item.dispatchId ? ` dispatch=${item.dispatchId}` : ''}`
        + `${item.boundSessionId ? ` boundSession=${item.boundSessionId}` : ''}`
        + `${typeof item.revision === 'number' ? ` rev=${item.revision}` : ''}`
        + `${item.blockedBy && item.blockedBy.length > 0 ? ` blocked_by=${item.blockedBy.join('|')}` : ''}`
        + ` updated=${item.updatedAt}`,
      );
    }
  }
  lines.push('');
  lines.push('## Routing Rule');
  lines.push('- Context exposes concise status only.');
  lines.push('- Full task details and progression should be maintained in this TASK.md.');
  try {
    writeFileSync(taskFilePath, lines.join('\n') + '\n', 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    log.warn('Failed to write TASK.md snapshot', {
      taskFilePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ProjectStatusGatewayPatch {
  active?: boolean;
  status?: ProjectTaskLifecycleStatus;
  sourceAgentId?: string;
  targetAgentId?: string;
  assignerName?: string;
  assigneeWorkerId?: string;
  assigneeWorkerName?: string;
  deliveryWorkerId?: string;
  deliveryWorkerName?: string;
  reviewerId?: string;
  reviewerName?: string;
  reassignReason?: string;
  taskId?: string;
  taskName?: string;
  dispatchId?: string;
  boundSessionId?: string;
  revision?: number;
  summary?: string;
  note?: string;
  blockedBy?: string[];
  requestId?: string;
}

export interface ProjectStatusGatewayApplyResult {
  ok: boolean;
  appliedSessionIds: string[];
  skippedSessionIds: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export function applyProjectStatusGatewayPatch(params: {
  sessionManager: SessionManager;
  sessionIds: string[];
  patch: ProjectStatusGatewayPatch;
  source?: string;
}): ProjectStatusGatewayApplyResult {
  const appliedSessionIds: string[] = [];
  const skippedSessionIds: string[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];
  const sessionIds = Array.from(new Set(params.sessionIds.map((item) => item.trim()).filter((item) => item.length > 0)));
  const nowMs = Date.now();
  for (const [key, ts] of eventDedupTsByKey.entries()) {
    if (nowMs - ts > EVENT_DEDUP_TTL_MS) eventDedupTsByKey.delete(key);
  }
  for (const sessionId of sessionIds) {
    try {
      const requestId = asTrimmedString(params.patch.requestId);
      const dedupeKey = requestId
        ? `${sessionId}|${requestId}|${params.patch.status ?? ''}|${params.patch.revision ?? ''}`
        : '';
      if (dedupeKey && eventDedupTsByKey.has(dedupeKey)) {
        skippedSessionIds.push(sessionId);
        continue;
      }
      const session = params.sessionManager.getSession(sessionId);
      if (!session) {
        skippedSessionIds.push(sessionId);
        continue;
      }
      const current = parseProjectTaskState(session.context?.projectTaskState);
      const next = mergeProjectTaskState(current, {
        ...params.patch,
        ...(params.patch.blockedBy && params.patch.blockedBy.length > 0 ? { blockedBy: params.patch.blockedBy } : {}),
      });
      const explicitBlockedBy = params.patch.blockedBy;
      const blockedBy = normalizeBlockedBy(explicitBlockedBy ?? current?.blockedBy);
      if (hasExplicitBlockedByInput(explicitBlockedBy) && !blockedBy) {
        errors.push({
          sessionId,
          error: 'invalid blocked_by: cannot mix "none" with real dependency ids',
        });
        continue;
      }
      if (!blockedBy) {
        next.blockedBy = [BLOCKED_BY_NONE];
      } else {
        next.blockedBy = blockedBy;
      }
      const semanticNoop = isSemanticNoopPatch(current, next);
      const currentRevision = normalizeRevision(current?.revision) ?? 1;
      const explicitRevision = normalizeRevision(params.patch.revision);
      if (explicitRevision === undefined) {
        next.revision = current ? (semanticNoop ? currentRevision : currentRevision + 1) : 1;
      } else {
        next.revision = explicitRevision;
      }
      if (current && next.revision !== undefined) {
        if (next.revision < currentRevision) {
          errors.push({
            sessionId,
            error: `revision regression: current=${currentRevision}, next=${next.revision}`,
          });
          continue;
        }
        if (next.revision === currentRevision && !semanticNoop) {
          errors.push({
            sessionId,
            error: `out-of-order event: revision=${next.revision} does not advance for non-noop patch`,
          });
          continue;
        }
      }
      if (semanticNoop) {
        skippedSessionIds.push(sessionId);
        if (dedupeKey) eventDedupTsByKey.set(dedupeKey, nowMs);
        continue;
      }
      const transition = validateTransition(current, next);
      if (!transition.ok) {
        errors.push({ sessionId, error: transition.error });
        continue;
      }
      const currentRegistry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
      const nextRegistry = upsertDelegatedProjectTaskRegistry(currentRegistry, {
        sourceAgentId: next.sourceAgentId,
        targetAgentId: next.targetAgentId,
        assignerName: next.assignerName,
        assigneeWorkerId: next.assigneeWorkerId,
        assigneeWorkerName: next.assigneeWorkerName,
        deliveryWorkerId: next.deliveryWorkerId,
        deliveryWorkerName: next.deliveryWorkerName,
        reviewerId: next.reviewerId,
        reviewerName: next.reviewerName,
        reassignReason: next.reassignReason,
        taskId: next.taskId,
        taskName: next.taskName,
        status: next.status,
        active: next.active,
        dispatchId: next.dispatchId,
        boundSessionId: next.boundSessionId,
        revision: next.revision,
        summary: next.summary,
        note: next.note,
        blockedBy: next.blockedBy,
      });
      const shouldArchiveAndClear = shouldArchiveAndClearProjectTaskState(next);
      if (shouldArchiveAndClear) {
        appendClosedProjectTaskArchive(session.projectPath, next);
      }
      const contextState = shouldArchiveAndClear ? null : next;
      const contextRegistry = shouldArchiveAndClear
        ? pruneDelegatedRegistryForContextAfterTaskClosed(nextRegistry, next)
        : nextRegistry;
      params.sessionManager.updateContext(sessionId, {
        projectTaskState: contextState,
        projectTaskRegistry: contextRegistry,
      });
      writeTaskRouterMarkdown(session.projectPath, next, nextRegistry);
      appliedSessionIds.push(sessionId);
      if (dedupeKey) eventDedupTsByKey.set(dedupeKey, nowMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ sessionId, error: message });
      log.warn('applyProjectStatusGatewayPatch failed', {
        sessionId,
        source: params.source ?? 'unknown',
        error: message,
      });
    }
  }
  return {
    ok: errors.length === 0,
    appliedSessionIds,
    skippedSessionIds,
    errors,
  };
}

export interface ProjectStatusSnapshot {
  sessionId: string;
  projectPath: string;
  hasState: boolean;
  stale: boolean;
  active: boolean;
  taskState: ProjectTaskState | null;
  registry: DelegatedProjectTaskRecord[];
}

export function readProjectStatusSnapshot(params: {
  sessionManager: SessionManager;
  sessionId: string;
  staleMs?: number;
}): ProjectStatusSnapshot | null {
  const sessionId = params.sessionId.trim();
  if (!sessionId) return null;
  const session = params.sessionManager.getSession(sessionId);
  if (!session) return null;
  const taskState = parseProjectTaskState(session.context?.projectTaskState);
  const registry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
  const updatedAtMs = Date.parse(taskState?.updatedAt ?? '');
  const staleThreshold = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs)
    ? Math.max(0, Math.floor(params.staleMs))
    : STALE_MS_DEFAULT;
  const stale = !Number.isFinite(updatedAtMs) || (Date.now() - updatedAtMs > staleThreshold);
  const active = !!taskState && taskState.active === true && ACTIVE_STATUSES.has(taskState.status);
  return {
    sessionId,
    projectPath: session.projectPath,
    hasState: !!taskState,
    stale,
    active,
    taskState,
    registry,
  };
}

export function listStaleProjectStatusSnapshots(params: {
  sessionManager: SessionManager;
  staleMs?: number;
  projectPath?: string;
  onlyActive?: boolean;
}): ProjectStatusSnapshot[] {
  const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs)
    ? Math.max(0, Math.floor(params.staleMs))
    : STALE_MS_DEFAULT;
  const normalizedProjectPath = asTrimmedString(params.projectPath).replace(/\/+$/, '');
  const sessions = params.sessionManager.listSessions();
  const snapshots: ProjectStatusSnapshot[] = [];
  for (const session of sessions) {
    const projectPath = asTrimmedString(session.projectPath).replace(/\/+$/, '');
    if (normalizedProjectPath && normalizedProjectPath !== projectPath) continue;
    const snapshot = readProjectStatusSnapshot({
      sessionManager: params.sessionManager,
      sessionId: session.id,
      staleMs,
    });
    if (!snapshot || !snapshot.hasState) continue;
    if (!snapshot.stale) continue;
    if (params.onlyActive === true && !snapshot.active) continue;
    snapshots.push(snapshot);
  }
  return snapshots.sort((a, b) => Date.parse(b.taskState?.updatedAt ?? '') - Date.parse(a.taskState?.updatedAt ?? ''));
}
