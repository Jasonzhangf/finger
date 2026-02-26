export type ClockTimerStatus = 'active' | 'completed' | 'canceled';
export type ClockScheduleType = 'delay' | 'at' | 'cron';
export type ClockAction = 'create' | 'list' | 'cancel' | 'update';

export interface ClockTimer {
  timer_id: string;
  message: string;
  schedule_type: ClockScheduleType;
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat: boolean;
  max_runs: number | null;
  run_count: number;
  next_fire_at: string | null;
  status: ClockTimerStatus;
  created_at: string;
  updated_at: string;
}

export interface ClockStore {
  timers: ClockTimer[];
}

export interface ClockInput {
  action: ClockAction;
  payload: Record<string, unknown>;
}

export interface ClockCreatePayload {
  message: string;
  schedule_type: string;
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat?: boolean;
  max_runs?: number;
}

export interface ClockListPayload {
  status?: string;
  limit?: number;
}

export interface ClockCancelPayload {
  timer_id: string;
}

export interface ClockUpdatePayload {
  timer_id: string;
  message?: string;
  schedule_type?: string;
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat?: boolean;
  max_runs?: number;
}

export interface ClockOutput {
  ok: boolean;
  action: ClockAction;
  timer_id?: string;
  content: string;
  data: Record<string, unknown>;
}

export interface NormalizedSchedule {
  schedule_type: ClockScheduleType;
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat: boolean;
  max_runs: number | null;
  next_fire_at: string;
}

export function parseClockInput(rawInput: unknown): ClockInput {
  if (!isRecord(rawInput)) throw new Error('clock input must be an object');
  if (!isRecord(rawInput.payload)) throw new Error('clock input.payload must be an object');

  const action = rawInput.action;
  if (action !== 'create' && action !== 'list' && action !== 'cancel' && action !== 'update') {
    throw new Error(`unsupported clock action: ${String(action)}`);
  }
  return { action, payload: rawInput.payload };
}

export function parseCreatePayload(payload: Record<string, unknown>): ClockCreatePayload {
  if (typeof payload.message !== 'string') throw new Error('failed to parse clock create payload: message is required');
  if (typeof payload.schedule_type !== 'string') throw new Error('failed to parse clock create payload: schedule_type is required');
  return {
    message: payload.message,
    schedule_type: payload.schedule_type,
    delay_seconds: toOptionalPositiveInteger(payload.delay_seconds),
    at: typeof payload.at === 'string' ? payload.at : undefined,
    cron: typeof payload.cron === 'string' ? payload.cron : undefined,
    timezone: typeof payload.timezone === 'string' ? payload.timezone : undefined,
    repeat: typeof payload.repeat === 'boolean' ? payload.repeat : undefined,
    max_runs: toOptionalPositiveInteger(payload.max_runs),
  };
}

export function parseListPayload(payload: Record<string, unknown>): ClockListPayload {
  return {
    status: typeof payload.status === 'string' ? payload.status : undefined,
    limit: toOptionalPositiveInteger(payload.limit),
  };
}

export function parseCancelPayload(payload: Record<string, unknown>): ClockCancelPayload {
  return { timer_id: requireNonEmptyString(payload.timer_id, 'failed to parse clock cancel payload: timer_id is required') };
}

export function parseUpdatePayload(payload: Record<string, unknown>): ClockUpdatePayload {
  return {
    timer_id: requireNonEmptyString(payload.timer_id, 'failed to parse clock update payload: timer_id is required'),
    message: typeof payload.message === 'string' ? payload.message : undefined,
    schedule_type: typeof payload.schedule_type === 'string' ? payload.schedule_type : undefined,
    delay_seconds: toOptionalPositiveInteger(payload.delay_seconds),
    at: typeof payload.at === 'string' ? payload.at : undefined,
    cron: typeof payload.cron === 'string' ? payload.cron : undefined,
    timezone: typeof payload.timezone === 'string' ? payload.timezone : undefined,
    repeat: typeof payload.repeat === 'boolean' ? payload.repeat : undefined,
    max_runs: toOptionalPositiveInteger(payload.max_runs),
  };
}

export function normalizeScheduleType(value: unknown): ClockScheduleType {
  if (value === 'delay' || value === 'at' || value === 'cron') return value;
  throw new Error(`unsupported schedule_type: ${String(value)}`);
}

export function parseListStatus(raw: string | undefined): ClockTimerStatus | 'all' {
  const status = raw ?? 'active';
  if (status === 'active' || status === 'completed' || status === 'canceled' || status === 'all') {
    return status;
  }
  throw new Error(`unsupported list status: ${status}`);
}

export function resolveRepeat(scheduleType: ClockScheduleType, requested: boolean | undefined): boolean {
  if (typeof requested === 'boolean') return requested;
  return scheduleType === 'cron';
}

export function resolveMaxRuns(repeat: boolean, rawMaxRuns: number | null | undefined): number | null {
  const normalized = typeof rawMaxRuns === 'number' && Number.isFinite(rawMaxRuns)
    ? Math.max(1, Math.floor(rawMaxRuns))
    : null;
  return repeat ? normalized : (normalized ?? 1);
}

export function parseFutureDate(raw: unknown, message: string): Date {
  const value = requireNonEmptyString(raw, message);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid `at` datetime format');
  if (parsed.getTime() <= Date.now()) throw new Error('`at` must be in the future');
  return parsed;
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  const normalized = toOptionalPositiveInteger(value);
  return normalized ?? fallback;
}

export function requirePositiveInteger(value: unknown, message: string): number {
  const normalized = toOptionalPositiveInteger(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

export function toOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

export function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

export function isClockTimer(value: unknown): value is ClockTimer {
  if (!isRecord(value)) return false;
  return (
    typeof value.timer_id === 'string' &&
    typeof value.message === 'string' &&
    (value.schedule_type === 'delay' || value.schedule_type === 'at' || value.schedule_type === 'cron') &&
    typeof value.repeat === 'boolean' &&
    typeof value.run_count === 'number' &&
    (value.status === 'active' || value.status === 'completed' || value.status === 'canceled') &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
