/**
 * Clock Task Injector
 *
 * Polls clock timers and injects tasks into agents when due.
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { AgentDispatchRequest } from '../server/modules/agent-runtime/types.js';

export interface ClockInjectPayload {
  agentId: string;
  sessionId?: string;
  projectPath?: string;
  prompt: string;
  channelId?: string;
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

export class ClockTaskInjector {
  private timer: NodeJS.Timeout | null = null;
  private storePath: string;
  private running = false;

  constructor(private deps: ClockInjectorDeps, storePath?: string) {
    this.storePath = storePath || path.join(FINGER_PATHS.runtime.clockDir, 'tool-timers.json');
  }

  start(intervalMs: number = DEFAULT_POLL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.deps.log?.('[ClockInjector] started', { intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const store = this.loadStore();
      const now = Date.now();

      for (const timer of store.timers) {
        if (timer.status !== 'active') continue;
        if (!timer.next_fire_at) continue;
        if (!timer.inject) continue;

        const nextAt = Date.parse(timer.next_fire_at);
        if (!Number.isFinite(nextAt)) continue;

        if (nextAt <= now) {
          await this.inject(timer);
        timer.last_injected_at = new Date().toISOString();
        // Increment run_count and update schedule
        timer.run_count += 1;
        if (!timer.repeat || (timer.max_runs !== null && timer.run_count >= timer.max_runs)) {
          timer.status = 'completed';
          timer.next_fire_at = null;
        }
        // Do not modify schedule/run_count here (clock tool handles schedule)
        }
      }

      this.saveStore(store);
    } catch (err) {
      this.deps.log?.('[ClockInjector] error', err);
    } finally {
      this.running = false;
    }
  }

  private async inject(timer: ClockInjectTimer): Promise<void> {
    const inject = timer.inject!;
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
        timerId: timer.timer_id,
        message: timer.message,
        channelId,
      },
      blocking: false,
      queueOnBusy: true,
      maxQueueWaitMs: 60_000,
    };

    this.deps.log?.('[ClockInjector] dispatch', request);
    await this.deps.dispatchTaskToAgent(request);
  }

  private loadStore(): ClockInjectStore {
    try {
      if (!fs.existsSync(this.storePath)) return { timers: [] };
      const content = fs.readFileSync(this.storePath, 'utf-8');
      const parsed = JSON.parse(content) as ClockInjectStore;
      return parsed;
    } catch {
      return { timers: [] };
    }
  }

  private saveStore(store: ClockInjectStore): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2), 'utf-8');
  }
}
