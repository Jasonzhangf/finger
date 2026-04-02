export type SystemTaskLifecycleStatus =
  | 'planning'
  | 'in_progress'
  | 'monitoring'
  | 'blocked'
  | 'pending_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface SystemTaskState {
  active: boolean;
  status: SystemTaskLifecycleStatus;
  updatedAt: string;
  taskId?: string;
  taskName?: string;
  summary?: string;
  note?: string;
  explanation?: string;
  currentStep?: string;
  nextStep?: string;
  planTotal?: number;
  planCompleted?: number;
  originMessageId?: string;
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asOptionalNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : undefined;
}

function normalizeStatus(value: unknown): SystemTaskLifecycleStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'planning' || normalized === 'plan') return 'planning';
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'running') return 'in_progress';
  if (normalized === 'monitoring' || normalized === 'monitor') return 'monitoring';
  if (normalized === 'blocked' || normalized === 'blocking') return 'blocked';
  if (normalized === 'pending_approval' || normalized === 'pending approval') return 'pending_approval';
  if (normalized === 'completed' || normalized === 'done' || normalized === 'pass') return 'completed';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return null;
}

export function parseSystemTaskState(value: unknown): SystemTaskState | null {
  if (!isObjectRecord(value)) return null;
  const status = normalizeStatus(value.status);
  if (!status) return null;
  const updatedAt = asOptionalString(value.updatedAt) ?? new Date().toISOString();
  return {
    active: value.active === true,
    status,
    updatedAt,
    ...(asOptionalString(value.taskId) ? { taskId: asOptionalString(value.taskId) } : {}),
    ...(asOptionalString(value.taskName) ? { taskName: asOptionalString(value.taskName) } : {}),
    ...(asOptionalString(value.summary) ? { summary: asOptionalString(value.summary) } : {}),
    ...(asOptionalString(value.note) ? { note: asOptionalString(value.note) } : {}),
    ...(asOptionalString(value.explanation) ? { explanation: asOptionalString(value.explanation) } : {}),
    ...(asOptionalString(value.currentStep) ? { currentStep: asOptionalString(value.currentStep) } : {}),
    ...(asOptionalString(value.nextStep) ? { nextStep: asOptionalString(value.nextStep) } : {}),
    ...(typeof asOptionalNonNegativeInt(value.planTotal) === 'number'
      ? { planTotal: asOptionalNonNegativeInt(value.planTotal) }
      : {}),
    ...(typeof asOptionalNonNegativeInt(value.planCompleted) === 'number'
      ? { planCompleted: asOptionalNonNegativeInt(value.planCompleted) }
      : {}),
    ...(asOptionalString(value.originMessageId) ? { originMessageId: asOptionalString(value.originMessageId) } : {}),
  };
}

export function mergeSystemTaskState(
  current: SystemTaskState | null,
  patch: Partial<SystemTaskState>,
): SystemTaskState {
  const nowIso = new Date().toISOString();
  const status = normalizeStatus(patch.status) ?? current?.status ?? 'planning';
  const active = typeof patch.active === 'boolean'
    ? patch.active
    : current?.active ?? (status !== 'completed' && status !== 'failed' && status !== 'cancelled');

  return {
    active,
    status,
    updatedAt: nowIso,
    ...(asOptionalString(patch.taskId) ?? current?.taskId ? { taskId: asOptionalString(patch.taskId) ?? current?.taskId } : {}),
    ...(asOptionalString(patch.taskName) ?? current?.taskName ? { taskName: asOptionalString(patch.taskName) ?? current?.taskName } : {}),
    ...(asOptionalString(patch.summary) ?? current?.summary ? { summary: asOptionalString(patch.summary) ?? current?.summary } : {}),
    ...(asOptionalString(patch.note) ?? current?.note ? { note: asOptionalString(patch.note) ?? current?.note } : {}),
    ...(asOptionalString(patch.explanation) ?? current?.explanation
      ? { explanation: asOptionalString(patch.explanation) ?? current?.explanation }
      : {}),
    ...(asOptionalString(patch.currentStep) ?? current?.currentStep
      ? { currentStep: asOptionalString(patch.currentStep) ?? current?.currentStep }
      : {}),
    ...(asOptionalString(patch.nextStep) ?? current?.nextStep
      ? { nextStep: asOptionalString(patch.nextStep) ?? current?.nextStep }
      : {}),
    ...(typeof asOptionalNonNegativeInt(patch.planTotal) === 'number' || typeof current?.planTotal === 'number'
      ? { planTotal: asOptionalNonNegativeInt(patch.planTotal) ?? current?.planTotal }
      : {}),
    ...(typeof asOptionalNonNegativeInt(patch.planCompleted) === 'number' || typeof current?.planCompleted === 'number'
      ? { planCompleted: asOptionalNonNegativeInt(patch.planCompleted) ?? current?.planCompleted }
      : {}),
    ...(asOptionalString(patch.originMessageId) ?? current?.originMessageId
      ? { originMessageId: asOptionalString(patch.originMessageId) ?? current?.originMessageId }
      : {}),
  };
}

export function isSystemTaskStateActive(state: SystemTaskState | null | undefined, nowMs = Date.now()): boolean {
  if (!state || state.active !== true) return false;
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') return false;
  const updatedAtMs = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return false;
  if (nowMs - updatedAtMs > STALE_MS) return false;
  return true;
}
