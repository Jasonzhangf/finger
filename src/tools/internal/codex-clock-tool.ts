import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../../core/finger-paths.js';
import { InternalTool } from './types.js';
import { computeNextCronFireAt, validateTimezone } from './codex-clock-cron.js';
import {
  type ClockTimer,
  type ClockStore,
  type ClockCreatePayload,
  type ClockListPayload,
  type ClockCancelPayload,
  type ClockUpdatePayload,
  type ClockOutput,
  type NormalizedSchedule,
  parseClockInput,
  parseCreatePayload,
  parseListPayload,
  parseCancelPayload,
  parseUpdatePayload,
  normalizeScheduleType,
  parseListStatus,
  resolveRepeat,
  resolveMaxRuns,
  parseFutureDate,
  normalizePositiveInteger,
  requirePositiveInteger,
  requireNonEmptyString,
  isClockTimer,
} from './codex-clock-schema.js';

const CLOCK_MAX_ACTIVE_TIMERS = 3;
const CLOCK_DEFAULT_LIST_LIMIT = 50;

class ClockStoreManager {
  private loaded = false;
  private readonly timers = new Map<string, ClockTimer>();

  constructor(private readonly storePath: string) {}

  create(payload: ClockCreatePayload): ClockTimer {
    this.ensureLoaded();
    this.refreshDueTimers();

    if (this.countActiveTimers() >= CLOCK_MAX_ACTIVE_TIMERS) {
      throw new Error(`active timer limit reached (max ${CLOCK_MAX_ACTIVE_TIMERS} per task)`);
    }

    const now = new Date();
    const schedule = normalizeCreateSchedule(payload, now);
    const timer: ClockTimer = {
      timer_id: randomUUID(),
      message: payload.message.trim(),
      schedule_type: schedule.schedule_type,
      delay_seconds: schedule.delay_seconds,
      at: schedule.at,
      cron: schedule.cron,
      timezone: schedule.timezone,
      repeat: schedule.repeat,
      max_runs: schedule.max_runs,
      run_count: 0,
      next_fire_at: schedule.next_fire_at,
      status: 'active',
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.timers.set(timer.timer_id, timer);
    this.persist();
    return timer;
  }

  list(payload: ClockListPayload): ClockTimer[] {
    this.ensureLoaded();
    this.refreshDueTimers();

    const status = parseListStatus(payload.status);
    const limit = normalizePositiveInteger(payload.limit, CLOCK_DEFAULT_LIST_LIMIT);
    return Array.from(this.timers.values())
      .filter((timer) => status === 'all' || timer.status === status)
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .slice(0, limit);
  }

  cancel(payload: ClockCancelPayload): ClockTimer {
    this.ensureLoaded();
    this.refreshDueTimers();

    const timer = this.timers.get(payload.timer_id);
    if (!timer) throw new Error(`timer not found: ${payload.timer_id}`);

    timer.status = 'canceled';
    timer.next_fire_at = null;
    timer.updated_at = new Date().toISOString();
    this.persist();
    return timer;
  }

  update(payload: ClockUpdatePayload): ClockTimer {
    this.ensureLoaded();
    this.refreshDueTimers();

    const timer = this.timers.get(payload.timer_id);
    if (!timer) throw new Error(`timer not found: ${payload.timer_id}`);

    const now = new Date();
    if (typeof payload.message === 'string' && payload.message.trim().length > 0) {
      timer.message = payload.message.trim();
    }

    const schedule = normalizeUpdateSchedule(timer, payload, now);
    timer.schedule_type = schedule.schedule_type;
    timer.delay_seconds = schedule.delay_seconds;
    timer.at = schedule.at;
    timer.cron = schedule.cron;
    timer.timezone = schedule.timezone;
    timer.repeat = schedule.repeat;
    timer.max_runs = schedule.max_runs;
    timer.run_count = 0;
    timer.next_fire_at = schedule.next_fire_at;
    timer.status = 'active';
    timer.updated_at = now.toISOString();

    this.persist();
    return timer;
  }

  private countActiveTimers(): number {
    let active = 0;
    for (const timer of this.timers.values()) {
      if (timer.status === 'active') active += 1;
    }
    return active;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;

    if (!existsSync(this.storePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf-8')) as ClockStore;
      for (const timer of Array.isArray(parsed.timers) ? parsed.timers : []) {
        if (isClockTimer(timer)) this.timers.set(timer.timer_id, timer);
      }
    } catch {
      // ignore invalid persisted store
    }
  }

  private refreshDueTimers(): void {
    this.ensureLoaded();
    const now = Date.now();
    let changed = false;

    for (const timer of this.timers.values()) {
      if (timer.status !== 'active' || !timer.next_fire_at) continue;

      let nextAtMs = Date.parse(timer.next_fire_at);
      if (!Number.isFinite(nextAtMs)) {
        timer.status = 'completed';
        timer.next_fire_at = null;
        timer.updated_at = new Date().toISOString();
        changed = true;
        continue;
      }

      while (nextAtMs <= now) {
        timer.run_count += 1;
        changed = true;

        if (!timer.repeat || (timer.max_runs !== null && timer.run_count >= timer.max_runs)) {
          timer.status = 'completed';
          timer.next_fire_at = null;
          break;
        }

        const next = computeNextRunForTimer(timer, nextAtMs);
        if (!next) {
          timer.status = 'completed';
          timer.next_fire_at = null;
          break;
        }

        nextAtMs = next.getTime();
        timer.next_fire_at = next.toISOString();
      }

      timer.updated_at = new Date().toISOString();
    }

    if (changed) this.persist();
  }

  private persist(): void {
    const dir = path.dirname(this.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const payload: ClockStore = {
      timers: Array.from(this.timers.values()).sort((left, right) => left.timer_id.localeCompare(right.timer_id)),
    };
    writeFileSync(this.storePath, JSON.stringify(payload, null, 2), 'utf-8');
  }
}

export const clockTool: InternalTool<unknown, ClockOutput> = {
  name: 'clock',
  description:
    'Use clock when you need to wait or schedule progress supervision. Supports create/list/cancel/update actions.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'One of: create, list, cancel, update.' },
      payload: { type: 'object', additionalProperties: true },
    },
    required: ['action', 'payload'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown): Promise<ClockOutput> => {
    const input = parseClockInput(rawInput);
    const store = getClockStore();

    if (input.action === 'create') {
      const timer = store.create(parseCreatePayload(input.payload));
      return {
        ok: true,
        action: 'create',
        timer_id: timer.timer_id,
        content: 'clock created',
        data: { next_fire_at: timer.next_fire_at, schedule: compactSchedule(timer) },
      };
    }

    if (input.action === 'list') {
      const timers = store.list(parseListPayload(input.payload));
      return { ok: true, action: 'list', content: 'clock list fetched', data: { timers } };
    }

    if (input.action === 'cancel') {
      const timer = store.cancel(parseCancelPayload(input.payload));
      return {
        ok: true,
        action: 'cancel',
        timer_id: timer.timer_id,
        content: 'clock canceled',
        data: { status: timer.status },
      };
    }

    const timer = store.update(parseUpdatePayload(input.payload));
    return {
      ok: true,
      action: 'update',
      timer_id: timer.timer_id,
      content: 'clock updated',
      data: { next_fire_at: timer.next_fire_at, schedule: compactSchedule(timer) },
    };
  },
};

let globalClockStore: ClockStoreManager | null = null;

function getClockStore(): ClockStoreManager {
  if (!globalClockStore) globalClockStore = new ClockStoreManager(resolveClockStorePath());
  return globalClockStore;
}

function resolveClockStorePath(): string {
  const envPath = process.env.FINGER_CLOCK_STORE_PATH;
  if (envPath && envPath.trim().length > 0) return envPath.trim();
  ensureDir(FINGER_PATHS.runtime.clockDir);
  return path.join(FINGER_PATHS.runtime.clockDir, 'tool-timers.json');
}

function normalizeCreateSchedule(payload: ClockCreatePayload, now: Date): NormalizedSchedule {
  if (typeof payload.message !== 'string' || payload.message.trim().length === 0) {
    throw new Error('message cannot be empty');
  }

  const scheduleType = normalizeScheduleType(payload.schedule_type);
  const repeat = resolveRepeat(scheduleType, payload.repeat);
  const maxRuns = resolveMaxRuns(repeat, payload.max_runs);

  if (scheduleType === 'delay') {
    const delaySeconds = requirePositiveInteger(payload.delay_seconds, 'delay_seconds is required for delay schedule');
    return {
      schedule_type: 'delay',
      delay_seconds: delaySeconds,
      repeat,
      max_runs: maxRuns,
      next_fire_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    };
  }

  if (scheduleType === 'at') {
    const atDate = parseFutureDate(payload.at, 'at is required for at schedule');
    return {
      schedule_type: 'at',
      at: atDate.toISOString(),
      repeat,
      max_runs: maxRuns,
      next_fire_at: atDate.toISOString(),
    };
  }

  const cronExpr = requireNonEmptyString(payload.cron, 'cron is required for cron schedule');
  const timezone = validateTimezone(payload.timezone ?? 'UTC');
  const next = computeNextCronFireAt(cronExpr, timezone, now);
  return {
    schedule_type: 'cron',
    cron: cronExpr,
    timezone,
    repeat,
    max_runs: maxRuns,
    next_fire_at: next.toISOString(),
  };
}

function normalizeUpdateSchedule(timer: ClockTimer, payload: ClockUpdatePayload, now: Date): NormalizedSchedule {
  const scheduleType = normalizeScheduleType(payload.schedule_type ?? timer.schedule_type);
  const repeat = resolveRepeat(scheduleType, payload.repeat ?? timer.repeat);
  const maxRuns = resolveMaxRuns(repeat, payload.max_runs ?? timer.max_runs);

  if (scheduleType === 'delay') {
    const delaySeconds = requirePositiveInteger(
      payload.delay_seconds ?? timer.delay_seconds,
      'delay_seconds is required for delay schedule',
    );
    return {
      schedule_type: 'delay',
      delay_seconds: delaySeconds,
      repeat,
      max_runs: maxRuns,
      next_fire_at: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    };
  }

  if (scheduleType === 'at') {
    const atDate = parseFutureDate(payload.at ?? timer.at, 'at is required for at schedule');
    return {
      schedule_type: 'at',
      at: atDate.toISOString(),
      repeat,
      max_runs: maxRuns,
      next_fire_at: atDate.toISOString(),
    };
  }

  const cronExpr = requireNonEmptyString(payload.cron ?? timer.cron, 'cron is required for cron schedule');
  const timezone = validateTimezone(payload.timezone ?? timer.timezone ?? 'UTC');
  const next = computeNextCronFireAt(cronExpr, timezone, now);
  return {
    schedule_type: 'cron',
    cron: cronExpr,
    timezone,
    repeat,
    max_runs: maxRuns,
    next_fire_at: next.toISOString(),
  };
}

function compactSchedule(timer: ClockTimer): Record<string, unknown> {
  return {
    schedule_type: timer.schedule_type,
    delay_seconds: timer.delay_seconds,
    at: timer.at,
    cron: timer.cron,
    timezone: timer.timezone,
  };
}

function computeNextRunForTimer(timer: ClockTimer, previousFireMs: number): Date | null {
  if (timer.schedule_type === 'delay') {
    if (!timer.delay_seconds || timer.delay_seconds <= 0) return null;
    return new Date(previousFireMs + timer.delay_seconds * 1000);
  }
  if (timer.schedule_type === 'at') {
    return null;
  }
  if (!timer.cron) return null;
  const timezone = validateTimezone(timer.timezone ?? 'UTC');
  return computeNextCronFireAt(timer.cron, timezone, new Date(previousFireMs));
}
