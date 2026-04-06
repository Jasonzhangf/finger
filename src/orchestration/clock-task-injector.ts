/**
 * Clock Task Injector
 *
 * Polls clock timers and injects tasks into agents when due.
 * Supports hook execution before injection for pre-condition checks.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { AgentDispatchRequest } from '../server/modules/agent-runtime/types.js';
import { computeNextClockRunForTimer } from '../tools/internal/codex-clock-tool.js';
import { isClockTimer } from '../tools/internal/codex-clock-schema.js';
import type { ProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../common/progress-delivery-policy.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import { logger } from '../core/logger.js';
import type { ClockHookPayload } from '../tools/internal/codex-clock-schema.js';

const execFileAsync = promisify(execFile);
const log = logger.module('ClockInjector');

export interface ClockInjectPayload {
  agentId: string;
  sessionId?: string;
  projectPath?: string;
  prompt: string;
  channelId?: string;
  progressDelivery?: ProgressDeliveryPolicy;
}

export interface ClockHookExecutionResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
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
  hook?: ClockHookPayload;
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
const DEFAULT_HOOK_TIMEOUT_MS = 300_000; // 5 min
const MAX_HOOK_TIMEOUT_MS = 600_000; // 10 min
const DEFAULT_HOOK_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_HOOK_INCLUDE_OUTPUT = true;
const DEFAULT_HOOK_HEADER = '[CLOCK HOOK RESULT]';

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
    let hookResult: ClockHookExecutionResult | undefined;
    if (timer.hook) {
      hookResult = await this.executeHook(timer.hook, timer.inject?.projectPath || process.cwd(), timer.timer_id);
    }

    // Hook-only timer (no inject): hook success marks completed, hook failure marks failed_attempts
    if (!timer.inject) {
      if (hookResult && !hookResult.ok) {
        this.markRunFailure(timer, nowMs, new Error(`clock hook failed: ${hookResult.command}`));
        this.deps.log?.('[ClockInjector] hook-only failed', {
          timerId: timer.timer_id,
          timedOut: hookResult.timedOut,
          exitCode: hookResult.exitCode,
        });
      } else {
        this.markRunSuccess(timer, dueAtMs, false);
        this.deps.log?.('[ClockInjector] hook-only success, marked completed', {
          timerId: timer.timer_id,
        });
      }
      return true;
    }

    // With inject: always inject (soft-fail mode), agent receives hookStatus in prompt
    try {
      await this.inject(timer, hookResult);
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

  private async executeHook(
    hook: ClockHookPayload,
    projectPath: string,
    timerId: string,
  ): Promise<ClockHookExecutionResult> {
    const command = hook.command;
    const cwd = hook.cwd ?? projectPath;
    const shell = hook.shell ?? '/bin/bash';
    const timeoutMs = Math.min(MAX_HOOK_TIMEOUT_MS, hook.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS);
    const maxOutputChars = hook.max_output_chars ?? DEFAULT_HOOK_MAX_OUTPUT_CHARS;
    const startMs = Date.now();

    log.info('[ClockInjector] executing hook', { timerId, command, cwd, shell, timeoutMs });

    try {
      // Use execFile with shell for safer execution
      const result = await execFileAsync(shell, ['-c', command], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: Math.min(1024 * 1024, maxOutputChars * 2), // Allow slightly more buffer
        killSignal: 'SIGKILL',
      });

      const stdout = this.truncateOutput(result.stdout, maxOutputChars);
      const stderr = this.truncateOutput(result.stderr, maxOutputChars);
      const durationMs = Date.now() - startMs;

      log.info('[ClockInjector] hook finished', {
        timerId,
        ok: true,
        exitCode: 0,
        timedOut: false,
        durationMs,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
      });

      return {
        ok: true,
        command,
        exitCode: 0,
        stdout,
        stderr,
        timedOut: false,
        durationMs,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startMs;
      const execErr = err as { killed?: boolean; code?: number; stdout?: string; stderr?: string; signal?: string };
      const timedOut = execErr.killed === true && execErr.signal === 'SIGKILL';
      const exitCode = execErr.code ?? null;
      const stdout = this.truncateOutput(execErr.stdout ?? '', maxOutputChars);
      const stderr = this.truncateOutput(execErr.stderr ?? '', maxOutputChars);

      log.warn('[ClockInjector] hook finished', {
        timerId,
        ok: false,
        exitCode,
        timedOut,
        durationMs,
        stdoutLen: stdout.length,
        stderrLen: stderr.length,
      });

      return {
        ok: timedOut || exitCode !== 0 ? false : true,
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs,
      };
    }
  }

  private truncateOutput(output: string, maxChars: number): string {
    if (output.length <= maxChars) return output;
    return output.slice(0, maxChars) + '[truncated]';
  }

  private composeInjectPrompt(
    originalPrompt: string,
    hookResult: ClockHookExecutionResult,
    hook: ClockHookPayload,
  ): string {
    const header = hook.prompt_header ?? DEFAULT_HOOK_HEADER;
    const includeOutput = hook.include_output_in_prompt ?? DEFAULT_HOOK_INCLUDE_OUTPUT;
    const cwd = hook.cwd ?? '';

    const lines: string[] = [
      header,
      `status=${hookResult.ok ? 'success' : 'failed'}`,
      `command=${hookResult.command}`,
      `exit_code=${hookResult.exitCode ?? 'null'}`,
      `timedOut=${hookResult.timedOut}`,
      `durationMs=${hookResult.durationMs}`,
    ];

    if (cwd) {
      lines.push(`cwd=${cwd}`);
    }

    if (includeOutput) {
      if (hookResult.stdout) {
        lines.push(`stdout=${hookResult.stdout}`);
      }
      if (hookResult.stderr) {
        lines.push(`stderr=${hookResult.stderr}`);
      }
    }

    lines.push('');
    lines.push('[ORIGINAL PROMPT]');
    lines.push(originalPrompt);

    return lines.join('\n');
  }

  private async inject(timer: ClockInjectTimer, hookResult?: ClockHookExecutionResult): Promise<void> {
    if (!timer.inject) return;
    const inject = timer.inject;
    const agentId = inject.agentId;
    const sessionId = inject.sessionId || `clock-${timer.timer_id}`;
    const projectPath = inject.projectPath || process.cwd();
    const channelId = inject.channelId || 'clock';

    // ensure session exists
    this.deps.ensureSession(sessionId, projectPath);

    let prompt = inject.prompt;
    let hookMetadata: Record<string, unknown> = {};

    if (hookResult && timer.hook) {
      prompt = this.composeInjectPrompt(inject.prompt, hookResult, timer.hook);
      hookMetadata = {
        hookStatus: hookResult.timedOut ? 'timeout' : hookResult.ok ? 'success' : 'failed',
        hookCommand: hookResult.command,
        hookExitCode: hookResult.exitCode,
        hookTimedOut: hookResult.timedOut,
        hookDurationMs: hookResult.durationMs,
      };
    }

    const request: AgentDispatchRequest = {
      sourceAgentId: 'clock-injector',
      targetAgentId: agentId,
      task: { prompt },
      sessionId,
      metadata: {
        source: 'clock',
        role: 'system',
        timerId: timer.timer_id,
        message: timer.message,
        channelId,
        ...hookMetadata,
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
    writeFileAtomicSync(this.storePath, data);
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
