import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const SYSTEM_AGENT_ID = 'finger-system-agent';
export const PROJECT_AGENT_ID = 'finger-project-agent';
const BLOCKED_BY_NONE = 'none';

export type ProjectTaskLifecycleStatus =
  | 'create'
  | 'dispatched'
  | 'accepted'
  | 'in_progress'
  | 'claimed_done'
  | 'pending_review'
  | 'approved'
  | 'rejected'
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
  priority?: number;
  updatedAt: string;
  assignerName?: string;
  assigneeWorkerId?: string;
  assigneeWorkerName?: string;
  deliveryWorkerId?: string;
  deliveryWorkerName?: string;
  reviewerId?: string;
  reviewerName?: string;
  reassignReason?: string;
  taskId?: string;
  epicId?: string;                // Epic ID (bd issue)
  bdStorePath?: string;           // BD store path for this project
  periodicKey?: string;           // Periodic task unique key (e.g., hb:project:jobName)
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
  assignerName?: string;
  assigneeWorkerId?: string;
  assigneeWorkerName?: string;
  deliveryWorkerId?: string;
  deliveryWorkerName?: string;
  reviewerId?: string;
  priority?: number;
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
  if (normalized === 'claimed_done' || normalized === 'claimed-done') return 'claimed_done';
  if (normalized === 'pending_review' || normalized === 'pending-review') return 'pending_review';
  if (normalized === 'approved') return 'approved';
  if (normalized === 'rejected') return 'rejected';
  if (
    normalized === 'claiming_finished'
    || normalized === 'claiming-finished'
    || normalized === 'waiting_review'
    || normalized === 'review_pending'
    || normalized === 'review_ready'
  ) return 'claiming_finished';
  if (normalized === 'reviewed') return 'reviewed';
  if (normalized === 'pending_approval' || normalized === 'pending approval') return 'reported';
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
    ...(asOptionalString(value.assignerName ?? value.assigner_name)
      ? { assignerName: asOptionalString(value.assignerName ?? value.assigner_name) }
      : {}),
    ...(asOptionalString(value.assigneeWorkerId ?? value.assignee_worker_id)
      ? { assigneeWorkerId: asOptionalString(value.assigneeWorkerId ?? value.assignee_worker_id) }
      : {}),
    ...(asOptionalString(value.assigneeWorkerName ?? value.assignee_worker_name)
      ? { assigneeWorkerName: asOptionalString(value.assigneeWorkerName ?? value.assignee_worker_name) }
      : {}),
    ...(asOptionalString(value.deliveryWorkerId ?? value.delivery_worker_id)
      ? { deliveryWorkerId: asOptionalString(value.deliveryWorkerId ?? value.delivery_worker_id) }
      : {}),
    ...(asOptionalString(value.deliveryWorkerName ?? value.delivery_worker_name)
      ? { deliveryWorkerName: asOptionalString(value.deliveryWorkerName ?? value.delivery_worker_name) }
      : {}),
    ...(asOptionalString(value.reviewerId ?? value.reviewer_id)
      ? { reviewerId: asOptionalString(value.reviewerId ?? value.reviewer_id) }
      : {}),
    ...(asOptionalString(value.reviewerName ?? value.reviewer_name)
      ? { reviewerName: asOptionalString(value.reviewerName ?? value.reviewer_name) }
      : {}),
    ...(asOptionalString(value.reassignReason ?? value.reassign_reason)
      ? { reassignReason: asOptionalString(value.reassignReason ?? value.reassign_reason) }
      : {}),
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
    ...(asOptionalString(patch.assignerName) ?? current?.assignerName
      ? { assignerName: asOptionalString(patch.assignerName) ?? current?.assignerName }
      : {}),
    ...(asOptionalString(patch.assigneeWorkerId) ?? current?.assigneeWorkerId
      ? { assigneeWorkerId: asOptionalString(patch.assigneeWorkerId) ?? current?.assigneeWorkerId }
      : {}),
    ...(asOptionalString(patch.assigneeWorkerName) ?? current?.assigneeWorkerName
      ? { assigneeWorkerName: asOptionalString(patch.assigneeWorkerName) ?? current?.assigneeWorkerName }
      : {}),
    ...(asOptionalString(patch.deliveryWorkerId) ?? current?.deliveryWorkerId
      ? { deliveryWorkerId: asOptionalString(patch.deliveryWorkerId) ?? current?.deliveryWorkerId }
      : {}),
    ...(asOptionalString(patch.deliveryWorkerName) ?? current?.deliveryWorkerName
      ? { deliveryWorkerName: asOptionalString(patch.deliveryWorkerName) ?? current?.deliveryWorkerName }
      : {}),
    ...(asOptionalString(patch.reviewerId) ?? current?.reviewerId
      ? { reviewerId: asOptionalString(patch.reviewerId) ?? current?.reviewerId }
      : {}),
    ...(asOptionalString(patch.reviewerName) ?? current?.reviewerName
      ? { reviewerName: asOptionalString(patch.reviewerName) ?? current?.reviewerName }
      : {}),
    ...(asOptionalString(patch.reassignReason) ?? current?.reassignReason
      ? { reassignReason: asOptionalString(patch.reassignReason) ?? current?.reassignReason }
      : {}),
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
      ...(asOptionalString(item.assignerName ?? item.assigner_name)
        ? { assignerName: asOptionalString(item.assignerName ?? item.assigner_name) }
        : {}),
      ...(asOptionalString(item.assigneeWorkerId ?? item.assignee_worker_id)
        ? { assigneeWorkerId: asOptionalString(item.assigneeWorkerId ?? item.assignee_worker_id) }
        : {}),
      ...(asOptionalString(item.assigneeWorkerName ?? item.assignee_worker_name)
        ? { assigneeWorkerName: asOptionalString(item.assigneeWorkerName ?? item.assignee_worker_name) }
        : {}),
      ...(asOptionalString(item.deliveryWorkerId ?? item.delivery_worker_id)
        ? { deliveryWorkerId: asOptionalString(item.deliveryWorkerId ?? item.delivery_worker_id) }
        : {}),
      ...(asOptionalString(item.deliveryWorkerName ?? item.delivery_worker_name)
        ? { deliveryWorkerName: asOptionalString(item.deliveryWorkerName ?? item.delivery_worker_name) }
        : {}),
      ...(asOptionalString(item.reviewerId ?? item.reviewer_id)
        ? { reviewerId: asOptionalString(item.reviewerId ?? item.reviewer_id) }
        : {}),
      ...(asOptionalString(item.reviewerName ?? item.reviewer_name)
        ? { reviewerName: asOptionalString(item.reviewerName ?? item.reviewer_name) }
        : {}),
      ...(asOptionalString(item.reassignReason ?? item.reassign_reason)
        ? { reassignReason: asOptionalString(item.reassignReason ?? item.reassign_reason) }
        : {}),
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
    assignerName?: string;
    taskId?: string;
    taskName?: string;
    status?: ProjectTaskLifecycleStatus;
    active?: boolean;
    assigneeWorkerId?: string;
    assigneeWorkerName?: string;
    deliveryWorkerId?: string;
    deliveryWorkerName?: string;
    reviewerId?: string;
    reviewerName?: string;
    reassignReason?: string;
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
    ...(asOptionalString(patch.assignerName) ?? previous?.assignerName
      ? { assignerName: asOptionalString(patch.assignerName) ?? previous?.assignerName }
      : {}),
    ...(asOptionalString(patch.assigneeWorkerId) ?? previous?.assigneeWorkerId
      ? { assigneeWorkerId: asOptionalString(patch.assigneeWorkerId) ?? previous?.assigneeWorkerId }
      : {}),
    ...(asOptionalString(patch.assigneeWorkerName) ?? previous?.assigneeWorkerName
      ? { assigneeWorkerName: asOptionalString(patch.assigneeWorkerName) ?? previous?.assigneeWorkerName }
      : {}),
    ...(asOptionalString(patch.deliveryWorkerId) ?? previous?.deliveryWorkerId
      ? { deliveryWorkerId: asOptionalString(patch.deliveryWorkerId) ?? previous?.deliveryWorkerId }
      : {}),
    ...(asOptionalString(patch.deliveryWorkerName) ?? previous?.deliveryWorkerName
      ? { deliveryWorkerName: asOptionalString(patch.deliveryWorkerName) ?? previous?.deliveryWorkerName }
      : {}),
    ...(asOptionalString(patch.reviewerId) ?? previous?.reviewerId
      ? { reviewerId: asOptionalString(patch.reviewerId) ?? previous?.reviewerId }
      : {}),
    ...(asOptionalString(patch.reviewerName) ?? previous?.reviewerName
      ? { reviewerName: asOptionalString(patch.reviewerName) ?? previous?.reviewerName }
      : {}),
    ...(asOptionalString(patch.reassignReason) ?? previous?.reassignReason
      ? { reassignReason: asOptionalString(patch.reassignReason) ?? previous?.reassignReason }
      : {}),
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

export function shouldArchiveAndClearProjectTaskState(
  state: ProjectTaskState | null | undefined,
): state is ProjectTaskState {
  return !!state && state.active === false && state.status === 'closed';
}

function isSameTaskIdentity(
  record: DelegatedProjectTaskRecord,
  state: ProjectTaskState,
): boolean {
  if (state.taskId && record.taskId) return state.taskId === record.taskId;
  if (!state.taskId && state.taskName && record.taskName) return state.taskName === record.taskName;
  if (state.dispatchId && record.dispatchId) return state.dispatchId === record.dispatchId;
  return false;
}

export function pruneDelegatedRegistryForContextAfterTaskClosed(
  current: DelegatedProjectTaskRecord[],
  closedState: ProjectTaskState,
): DelegatedProjectTaskRecord[] {
  return current
    .filter((record) => {
      if (record.status === 'closed' && record.active === false) return false;
      if (isSameTaskIdentity(record, closedState)) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 64);
}

/**
 * Project Agent Task Queue (V3)
 * 
 * Project Agent 可以接收多个任务，按优先级执行
 * idle 标准：所有任务都被 System Agent close（activeTasks 为空）
 */
export interface ProjectAgentTaskQueue {
  /** 所有派发给 Project Agent 的任务 */
  registry: DelegatedProjectTaskRecord[];
  /** 当前正在执行的任务（active=true, status!=closed） */
  activeTasks: DelegatedProjectTaskRecord[];
  /** 当前优先执行的 taskId */
  currentTaskId?: string;
  /** 上一次任务关闭时间 */
  lastTaskClosedAt?: string;
}

/**
 * 判断 Project Agent 是否处于 idle 状态
 * 
 * idle 标准：所有任务都被 System Agent close（activeTasks 为空）
 */
export function isProjectAgentIdle(queue: ProjectAgentTaskQueue): boolean {
  if (queue.activeTasks.length === 0) return true;
  const allClosed = queue.activeTasks.every(task => task.status === 'closed');
  return allClosed;
}

/**
 * 按优先级排序任务
 * 
 * 优先级高的先执行，默认按 updatedAt（早的任务先执行）
 */
export function sortTasksByPriority(tasks: DelegatedProjectTaskRecord[]): DelegatedProjectTaskRecord[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== undefined && b.priority !== undefined) {
      return b.priority - a.priority;
    }
    if (a.priority !== undefined) return -1;
    if (b.priority !== undefined) return 1;
    return Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  });
}

/**
 * 选择下一个要执行的任务
 * 
 * 从 activeTasks 中按优先级选第一个非 closed 的任务
 */
export function pickNextTaskForProjectAgent(queue: ProjectAgentTaskQueue): DelegatedProjectTaskRecord | null {
  const sorted = sortTasksByPriority(queue.activeTasks);
  const nextTask = sorted.find(task => task.status !== 'closed');
  return nextTask ?? null;
}

/**
 * 从 registry 构建 Project Agent Task Queue
 */
export function buildProjectAgentTaskQueue(
  registry: DelegatedProjectTaskRecord[],
  currentTaskId?: string,
  lastTaskClosedAt?: string,
): ProjectAgentTaskQueue {
  const activeTasks = registry.filter(task => 
    task.active === true && task.status !== 'closed' && task.status !== 'failed' && task.status !== 'cancelled'
  );
  return {
    registry,
    activeTasks,
    currentTaskId,
    lastTaskClosedAt,
  };
}

/**
 * 获取 agent 的 bd 存储路径
 */
export function resolveBeadsStorePath(
  agentId: string,
  projectPath?: string,
): string {
  if (agentId === SYSTEM_AGENT_ID) {
    const fingerHome = process.env.FINGER_HOME ?? join(homedir(), '.finger');
    return join(fingerHome, 'beads', 'issues.jsonl');
  }
  // project agent: use project's .beads/issues.jsonl
  if (projectPath) {
    return join(projectPath, '.beads', 'issues.jsonl');
  }
  // fallback
  return '.beads/issues.jsonl';
}

/**
 * 验证 bd issue 是否存在且有效
 */
export function validateBdIssue(
  taskId: string,
  bdStorePath: string,
): { valid: boolean; status?: string; error?: string } {
  try {
    if (!existsSync(bdStorePath)) {
      return { valid: false, error: `bd store not found: ${bdStorePath}` };
    }
    
    const beadsDir = dirname(bdStorePath);
    const result = spawnSync('bd', ['--no-db', 'show', taskId, '--json'], {
      cwd: beadsDir,
      encoding: 'utf8',
      timeout: 5000,
    });
    
    if (result.error) {
      return { valid: false, error: result.error.message };
    }
    
    if (result.status !== 0) {
      if (result.stderr?.includes('not found') || result.stderr?.includes('No issue')) {
        return { valid: false, error: `bd issue ${taskId} not found` };
      }
      return { valid: false, error: `bd show failed: ${result.stderr}` };
    }
    
    try {
      const issue = JSON.parse(result.stdout);
      return { valid: true, status: issue.status };
    } catch {
      return { valid: true, status: 'unknown' };
    }
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 检查 bd issue 是否处于活跃状态（未完成）
 */
export function isBdIssueActive(status?: string): boolean {
  if (!status) return false;
  const activeStatuses = ['open', 'in_progress', 'blocked', 'started', 'pending'];
  return activeStatuses.includes(status.toLowerCase());
}
