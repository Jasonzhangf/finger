export const SYSTEM_AGENT_ID = 'finger-system-agent';
export const PROJECT_AGENT_ID = 'finger-project-agent';
const BLOCKED_BY_NONE = 'none';

export type ProjectTaskLifecycleStatus =
  | 'create'
  | 'dispatched'
  | 'accepted'
  | 'in_progress'
  | 'claiming_finished'
  | 'reviewed'
  | 'reported'
  | 'closed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface ProjectTaskState {
  active: boolean;
  status: ProjectTaskLifecycleStatus;
  sourceAgentId: string;
  targetAgentId: string;
  updatedAt: string;
  taskId?: string;
  taskName?: string;
  dispatchId?: string;
  boundSessionId?: string;
  revision?: number;
  summary?: string;
  note?: string;
  blockedBy?: string[];
}

export interface DelegatedProjectTaskRecord {
  key: string;
  sourceAgentId: string;
  targetAgentId: string;
  status: ProjectTaskLifecycleStatus;
  active: boolean;
  updatedAt: string;
  taskId?: string;
  taskName?: string;
  dispatchId?: string;
  boundSessionId?: string;
  revision?: number;
  summary?: string;
  note?: string;
  blockedBy?: string[];
}

const STALE_MS = 24 * 60 * 60 * 1000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBlockedByInput(value: unknown): string[] | undefined {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
      : [];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const unique = new Set<string>();
  let hasNone = false;
  for (const item of list) {
    const normalized = asOptionalString(item);
    if (!normalized) continue;
    if (normalized.toLowerCase() === BLOCKED_BY_NONE) {
      hasNone = true;
      continue;
    }
    unique.add(normalized);
  }
  if (unique.size > 0) return Array.from(unique.values());
  if (hasNone) return [BLOCKED_BY_NONE];
  return undefined;
}

export function normalizeBlockedByForTaskState(value: unknown): string[] | undefined {
  return normalizeBlockedByInput(value);
}

function normalizeStatus(value: unknown): ProjectTaskLifecycleStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'create' || normalized === 'created' || normalized === 'planned') return 'create';
  if (normalized === 'dispatching' || normalized === 'dispatched') return 'dispatched';
  if (normalized === 'accepted' || normalized === 'accept' || normalized === 'acknowledged') return 'accepted';
  if (
    normalized === 'in_progress'
    || normalized === 'running'
    || normalized === 'queued'
    || normalized === 'started'
    || normalized === 'executing'
  ) return 'in_progress';
  if (
    normalized === 'claiming_finished'
    || normalized === 'claiming-finished'
    || normalized === 'waiting_review'
    || normalized === 'review_pending'
    || normalized === 'review_ready'
  ) return 'claiming_finished';
  if (normalized === 'reviewed' || normalized === 'pending_approval' || normalized === 'pending approval') return 'reviewed';
  if (normalized === 'reported' || normalized === 'report_to_user' || normalized === 'report2user') return 'reported';
  if (normalized === 'closed' || normalized === 'completed' || normalized === 'done' || normalized === 'pass') return 'closed';
  if (normalized === 'blocked') return 'blocked';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return null;
}

function normalizeRevision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  if (normalized < 1) return undefined;
  return normalized;
}

export function parseProjectTaskState(value: unknown): ProjectTaskState | null {
  if (!isObjectRecord(value)) return null;
  const status = normalizeStatus(value.status);
  if (!status) return null;
  const active = value.active === true;
  const sourceAgentId = asOptionalString(value.sourceAgentId) ?? SYSTEM_AGENT_ID;
  const targetAgentId = asOptionalString(value.targetAgentId) ?? PROJECT_AGENT_ID;
  const updatedAt = asOptionalString(value.updatedAt) ?? new Date().toISOString();
  return {
    active,
    status,
    sourceAgentId,
    targetAgentId,
    updatedAt,
    ...(asOptionalString(value.taskId) ? { taskId: asOptionalString(value.taskId) } : {}),
    ...(asOptionalString(value.taskName) ? { taskName: asOptionalString(value.taskName) } : {}),
    ...(asOptionalString(value.dispatchId) ? { dispatchId: asOptionalString(value.dispatchId) } : {}),
    ...(asOptionalString(value.boundSessionId) ? { boundSessionId: asOptionalString(value.boundSessionId) } : {}),
    ...(normalizeRevision(value.revision) ? { revision: normalizeRevision(value.revision) } : {}),
    ...(asOptionalString(value.summary) ? { summary: asOptionalString(value.summary) } : {}),
    ...(asOptionalString(value.note) ? { note: asOptionalString(value.note) } : {}),
    ...(normalizeBlockedByInput(value.blockedBy ?? value.blocked_by) ? { blockedBy: normalizeBlockedByInput(value.blockedBy ?? value.blocked_by) } : {}),
  };
}

export function isProjectTaskStateActive(state: ProjectTaskState | null | undefined, nowMs = Date.now()): boolean {
  if (!state || state.active !== true) return false;
  if (state.targetAgentId !== PROJECT_AGENT_ID) return false;
  if (state.status === 'closed' || state.status === 'failed' || state.status === 'cancelled') return false;
  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  if (nowMs - updatedAtMs > STALE_MS) return false;
  return true;
}

export function mergeProjectTaskState(
  current: ProjectTaskState | null,
  patch: Partial<ProjectTaskState>,
): ProjectTaskState {
  const nowIso = new Date().toISOString();
  const nextStatus = normalizeStatus(patch.status) ?? current?.status ?? 'create';
  const nextTarget = asOptionalString(patch.targetAgentId) ?? current?.targetAgentId ?? PROJECT_AGENT_ID;
  const nextSource = asOptionalString(patch.sourceAgentId) ?? current?.sourceAgentId ?? SYSTEM_AGENT_ID;
  const nextActive = typeof patch.active === 'boolean'
    ? patch.active
    : current?.active ?? (nextStatus !== 'closed' && nextStatus !== 'failed' && nextStatus !== 'cancelled');
  const nextBlockedBy = normalizeBlockedByInput(patch.blockedBy ?? (patch as Record<string, unknown>).blocked_by)
    ?? current?.blockedBy;

  return {
    active: nextActive,
    status: nextStatus,
    sourceAgentId: nextSource,
    targetAgentId: nextTarget,
    updatedAt: nowIso,
    ...(asOptionalString(patch.taskId) ?? current?.taskId ? { taskId: asOptionalString(patch.taskId) ?? current?.taskId } : {}),
    ...(asOptionalString(patch.taskName) ?? current?.taskName ? { taskName: asOptionalString(patch.taskName) ?? current?.taskName } : {}),
    ...(asOptionalString(patch.dispatchId) ?? current?.dispatchId ? { dispatchId: asOptionalString(patch.dispatchId) ?? current?.dispatchId } : {}),
    ...(asOptionalString(patch.boundSessionId) ?? current?.boundSessionId
      ? { boundSessionId: asOptionalString(patch.boundSessionId) ?? current?.boundSessionId }
      : {}),
    ...(normalizeRevision(patch.revision) ?? current?.revision
      ? { revision: normalizeRevision(patch.revision) ?? current?.revision }
      : {}),
    ...(asOptionalString(patch.summary) ?? current?.summary ? { summary: asOptionalString(patch.summary) ?? current?.summary } : {}),
    ...(asOptionalString(patch.note) ?? current?.note ? { note: asOptionalString(patch.note) ?? current?.note } : {}),
    ...(nextBlockedBy ? { blockedBy: nextBlockedBy } : {}),
  };
}

export function parseDelegatedProjectTaskRegistry(value: unknown): DelegatedProjectTaskRecord[] {
  if (!Array.isArray(value)) return [];
  const records: DelegatedProjectTaskRecord[] = [];
  for (const item of value) {
    if (!isObjectRecord(item)) continue;
    const key = asOptionalString(item.key);
    const status = normalizeStatus(item.status);
    const sourceAgentId = asOptionalString(item.sourceAgentId) ?? SYSTEM_AGENT_ID;
    const targetAgentId = asOptionalString(item.targetAgentId) ?? PROJECT_AGENT_ID;
    const updatedAt = asOptionalString(item.updatedAt) ?? new Date().toISOString();
    if (!key || !status) continue;
    records.push({
      key,
      sourceAgentId,
      targetAgentId,
      status,
      active: item.active === true,
      updatedAt,
      ...(asOptionalString(item.taskId) ? { taskId: asOptionalString(item.taskId) } : {}),
      ...(asOptionalString(item.taskName) ? { taskName: asOptionalString(item.taskName) } : {}),
      ...(asOptionalString(item.dispatchId) ? { dispatchId: asOptionalString(item.dispatchId) } : {}),
      ...(asOptionalString(item.boundSessionId) ? { boundSessionId: asOptionalString(item.boundSessionId) } : {}),
      ...(normalizeRevision(item.revision) ? { revision: normalizeRevision(item.revision) } : {}),
      ...(asOptionalString(item.summary) ? { summary: asOptionalString(item.summary) } : {}),
      ...(asOptionalString(item.note) ? { note: asOptionalString(item.note) } : {}),
      ...(normalizeBlockedByInput(item.blockedBy ?? item.blocked_by) ? { blockedBy: normalizeBlockedByInput(item.blockedBy ?? item.blocked_by) } : {}),
    });
  }
  return records
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 64);
}

export function upsertDelegatedProjectTaskRegistry(
  current: DelegatedProjectTaskRecord[],
  patch: {
    sourceAgentId?: string;
    targetAgentId?: string;
    taskId?: string;
    taskName?: string;
    status?: ProjectTaskLifecycleStatus;
    active?: boolean;
    dispatchId?: string;
    boundSessionId?: string;
    revision?: number;
    summary?: string;
    note?: string;
    blockedBy?: string[];
  },
): DelegatedProjectTaskRecord[] {
  const status = normalizeStatus(patch.status) ?? 'create';
  const sourceAgentId = asOptionalString(patch.sourceAgentId) ?? SYSTEM_AGENT_ID;
  const targetAgentId = asOptionalString(patch.targetAgentId) ?? PROJECT_AGENT_ID;
  const taskId = asOptionalString(patch.taskId);
  const taskName = asOptionalString(patch.taskName);
  const key = [targetAgentId, taskId ?? '', taskName ?? '']
    .map((item) => item.replace(/\s+/g, '_'))
    .filter((item) => item.length > 0)
    .join(':');
  if (!key) return current.slice(0, 64);
  const nowIso = new Date().toISOString();
  const next = [...current];
  const index = next.findIndex((item) => item.key === key);
  const previous = index >= 0 ? next[index] : undefined;
  const active = typeof patch.active === 'boolean'
    ? patch.active
    : previous?.active ?? (status !== 'closed' && status !== 'failed' && status !== 'cancelled');
  const blockedBy = normalizeBlockedByInput(patch.blockedBy ?? (patch as Record<string, unknown>).blocked_by)
    ?? previous?.blockedBy;
  const record: DelegatedProjectTaskRecord = {
    key,
    sourceAgentId,
    targetAgentId,
    status,
    active,
    updatedAt: nowIso,
    ...(taskId ?? previous?.taskId ? { taskId: taskId ?? previous?.taskId } : {}),
    ...(taskName ?? previous?.taskName ? { taskName: taskName ?? previous?.taskName } : {}),
    ...(asOptionalString(patch.dispatchId) ?? previous?.dispatchId ? { dispatchId: asOptionalString(patch.dispatchId) ?? previous?.dispatchId } : {}),
    ...(asOptionalString(patch.boundSessionId) ?? previous?.boundSessionId
      ? { boundSessionId: asOptionalString(patch.boundSessionId) ?? previous?.boundSessionId }
      : {}),
    ...(normalizeRevision(patch.revision) ?? previous?.revision
      ? { revision: normalizeRevision(patch.revision) ?? previous?.revision }
      : {}),
    ...(asOptionalString(patch.summary) ?? previous?.summary ? { summary: asOptionalString(patch.summary) ?? previous?.summary } : {}),
    ...(asOptionalString(patch.note) ?? previous?.note ? { note: asOptionalString(patch.note) ?? previous?.note } : {}),
    ...(blockedBy ? { blockedBy } : {}),
  };
  if (index >= 0) {
    next[index] = record;
  } else {
    next.unshift(record);
  }
  return next
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 64);
}
