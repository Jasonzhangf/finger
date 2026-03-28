/**
 * Clock Task Injector
 *
 * Polls clock timers and injects tasks into agents when due.
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { AgentDispatchRequest } from '../server/modules/agent-runtime/types.js';
import { computeNextClockRunForTimer } from '../tools/internal/codex-clock-tool.js';
import { isClockTimer } from '../tools/internal/codex-clock-schema.js';
import type { ProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';

export interface ClockInjectPayload {
  agentId: string;
  sessionId?: string;
  projectPath?: string;
  prompt: string;
  channelId?: string;
  progressDelivery?: ProgressDeliveryPolicy;
}

export interface ClockInjectTimer {
  timer_id: string;
  message: string;
  schedule_type: 'delay' | 'at' | 'cron';
  delay_seconds?: number;
  at?: string;
  cron?: string;
  timezone?: string;
  repeat: boolean;
  max_runs: number | null;
  run_count: number;
  next_fire_at: string | null;
  status: 'active' | 'completed' | 'canceled';
  created_at: string;
  updated_at: string;
  // new fields
  inject?: ClockInjectPayload;
  last_injected_at?: string;
}

export interface ClockInjectStore {
  timers: ClockInjectTimer[];
}

export interface ClockInjectorDeps {
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  ensureSession: (sessionId: string, projectPath: string) => void;
  log?: (message: string, data?: unknown) => void;
}

const DEFAULT_POLL_MS = 10_000;
const MIN_REFIRE_GAP_MS = 1_000;
const MAX_TIMER_DELAY_MS = 60_000;
const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;
const DEFAULT_SCHEDULED_PROGRESS_DELIVERY = normalizeProgressDeliveryPolicy({ mode: 'result_only' });

export class ClockTaskInjector {
  private timer: NodeJS.Timeout | null = null;
  private storePath: string;
  private running = false;
  private started = false;
  private pollIntervalMs = DEFAULT_POLL_MS;

  constructor(private deps: ClockInjectorDeps, storePath?: string) {
    this.storePath = storePath || path.join(FINGER_PATHS.runtime.schedulesDir, 'clock-timers.jsonl');
  }

  start(intervalMs: number = DEFAULT_POLL_MS): void {
    if (this.started) return;
    this.pollIntervalMs = this.clampPositiveInt(intervalMs, DEFAULT_POLL_MS);
    this.started = true;
    this.deps.log?.('[ClockInjector] started', { intervalMs: this.pollIntervalMs });
    this.armTimer(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.deps.log?.('[ClockInjector] tick skipped (already running)');
      return;
    }
    this.running = true;

    try {
      const store = this.loadStore();
      const now = Date.now();
      let changed = false;

      for (const timer of store.timers) {
        if (timer.status !== 'active') continue;
        if (!timer.next_fire_at) {
          timer.status = 'completed';
          timer.updated_at = new Date().toISOString();
          changed = true;
          continue;
        }

        const nextAt = Date.parse(timer.next_fire_at);
        if (!Number.isFinite(nextAt)) {
          timer.status = 'completed';
          timer.next_fire_at = null;
          timer.updated_at = new Date().toISOString();
          changed = true;
          continue;
        }

        if (nextAt <= now) {
          changed = (await this.handleDueTimer(timer, nextAt, now)) || changed;
        }
      }

      if (changed) this.saveStore(store);
    } catch (err) {
      this.deps.log?.('[ClockInjector] error', err);
    } finally {
      this.running = false;
      if (this.started) this.armTimer(this.computeNextDelayMs());
    }
  }

  private async handleDueTimer(timer: ClockInjectTimer, dueAtMs: number, nowMs: number): Promise<boolean> {
    if (!timer.inject) {
      this.markRunSuccess(timer, dueAtMs, false);
      this.deps.log?.('[ClockInjector] due timer without inject payload, marked as completed/advanced', {
        timerId: timer.timer_id,
      });
      return true;
    }
    try {
      await this.inject(timer);
      this.markRunSuccess(timer, dueAtMs, true);
      return true;
    } catch (err) {
      this.markRunFailure(timer, nowMs, err);
      return true;
    }
  }

  private markRunSuccess(timer: ClockInjectTimer, dueAtMs: number, dispatched: boolean): void {
    const nowIso = new Date().toISOString();
    if (dispatched) timer.last_injected_at = nowIso;
    timer.run_count += 1;
    (timer as ClockInjectTimer & { failed_attempts?: number }).failed_attempts = 0;
    delete (timer as ClockInjectTimer & { last_error?: string }).last_error;
    delete (timer as ClockInjectTimer & { last_attempted_at?: string }).last_attempted_at;

    if (!timer.repeat || (timer.max_runs !== null && timer.run_count >= timer.max_runs)) {
      timer.status = 'completed';
      timer.next_fire_at = null;
      timer.updated_at = nowIso;
      return;
    }

    const next = computeNextClockRunForTimer(timer, dueAtMs);
    if (!next) {
      timer.status = 'completed';
      timer.next_fire_at = null;
      timer.updated_at = nowIso;
      return;
    }
    timer.next_fire_at = next.toISOString();
    timer.updated_at = nowIso;
  }

  private markRunFailure(timer: ClockInjectTimer, nowMs: number, err: unknown): void {
    const meta = timer as ClockInjectTimer & {
      failed_attempts?: number;
      last_error?: string;
      last_attempted_at?: string;
    };
    const attempts = (meta.failed_attempts ?? 0) + 1;
    const backoff = Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * (2 ** Math.max(0, attempts - 1)));
    const nextRetryAt = new Date(nowMs + backoff).toISOString();
    meta.failed_attempts = attempts;
    meta.last_error = err instanceof Error ? err.message : String(err);
    meta.last_attempted_at = new Date(nowMs).toISOString();
    if (!timer.next_fire_at || Date.parse(timer.next_fire_at) <= nowMs) {
      timer.next_fire_at = nextRetryAt;
    }
    timer.updated_at = new Date(nowMs).toISOString();
    this.deps.log?.('[ClockInjector] dispatch failed, retry scheduled', {
      timerId: timer.timer_id,
      attempts,
      nextRetryAt,
      error: meta.last_error,
    });
  }

  private async inject(timer: ClockInjectTimer): Promise<void> {
    if (!timer.inject) return;
    const inject = timer.inject;
    const agentId = inject.agentId;
    const sessionId = inject.sessionId || `clock-${timer.timer_id}`;
    const projectPath = inject.projectPath || process.cwd();
    const channelId = inject.channelId || 'clock';

    // ensure session exists
    this.deps.ensureSession(sessionId, projectPath);

    const request: AgentDispatchRequest = {
      sourceAgentId: 'clock-injector',
      targetAgentId: agentId,
      task: { prompt: inject.prompt },
      sessionId,
      metadata: {
        source: 'clock',
        role: 'system',
        timerId: timer.timer_id,
        message: timer.message,
        channelId,
        ...((inject.progressDelivery ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY)
          ? { scheduledProgressDelivery: inject.progressDelivery ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY }
          : {}),
      },
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 60_000,
    };

    this.deps.log?.('[ClockInjector] dispatch', request);
    const result = await this.deps.dispatchTaskToAgent(request);
    const asRecord = (typeof result === 'object' && result !== null) ? result as Record<string, unknown> : undefined;
    if (asRecord && asRecord.ok === false) {
      const error = typeof asRecord.error === 'string' ? asRecord.error : 'dispatch failed';
      throw new Error(error);
    }
  }

  private loadStore(): ClockInjectStore {
    try {
      if (!fs.existsSync(this.storePath)) return { timers: [] };
      const content = fs.readFileSync(this.storePath, 'utf-8');
      const timers: ClockInjectTimer[] = [];

      const trimmed = content.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as { timers?: unknown[] };
          for (const item of parsed.timers ?? []) {
            if (isClockTimer(item)) timers.push(item as ClockInjectTimer);
          }
        } catch {
          // fallback to jsonl parsing below
        }
      }

      if (timers.length === 0 && trimmed.length > 0) {
        const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        for (const line of lines) {
          try {
            const timer = JSON.parse(line);
            if (isClockTimer(timer)) timers.push(timer as ClockInjectTimer);
          } catch {
            // skip invalid line
          }
        }
      }
      return { timers };
    } catch {
      return { timers: [] };
    }
  }

  private saveStore(store: ClockInjectStore): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const lines = store.timers.map((t) => JSON.stringify(t));
    const data = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
    const tempPath = `${this.storePath}.tmp`;
    fs.writeFileSync(tempPath, data, 'utf-8');
    fs.renameSync(tempPath, this.storePath);
  }

  private armTimer(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.started) return;
    const raw = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : this.pollIntervalMs;
    const clamped = Math.min(raw, MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => {
      void this.tick();
    }, clamped);
    this.timer.unref?.();
  }

  private computeNextDelayMs(): number {
    const store = this.loadStore();
    const now = Date.now();
    let nextAtMs: number | null = null;
    for (const timer of store.timers) {
      if (timer.status !== 'active' || !timer.next_fire_at) continue;
      const parsed = Date.parse(timer.next_fire_at);
      if (!Number.isFinite(parsed)) continue;
      if (nextAtMs === null || parsed < nextAtMs) nextAtMs = parsed;
    }
    if (nextAtMs === null) return this.pollIntervalMs;
    const delay = Math.max(0, nextAtMs - now);
    if (delay === 0) return MIN_REFIRE_GAP_MS;
    return Math.min(this.pollIntervalMs, delay);
  }

  private clampPositiveInt(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : fallback;
  }
}
