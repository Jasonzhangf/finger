/**
 * Finger Core Daemon - Timer System
 * 
 * Second-level interval timers
 */

import { createConsoleLikeLogger } from './logger/console-like.js';

const clog = createConsoleLikeLogger('TimerSystem');

export type TimerCallback = () => void | Promise<void>;

export interface TimerHandle {
  id: string;
  interval: number;
  callback: TimerCallback;
  running: boolean;
}

export class TimerSystem {
  private timers: Map<string, TimerHandle> = new Map();

  create(id: string, intervalSec: number, callback: TimerCallback): TimerHandle {
    const handle: TimerHandle = {
      id,
      interval: intervalSec * 1000,
      callback,
      running: false,
    };
    this.timers.set(id, handle);
    return handle;
  }

  start(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer || timer.running) return false;

    const wrappedCallback = async () => {
      try {
        await timer.callback();
      } catch (err) {
        clog.error(`[Timer:${id}] Error:`, err);
      }
    };

    // Immediate first tick
    wrappedCallback();

    // Interval
    (timer as { _intervalId?: NodeJS.Timeout })._intervalId = setInterval(wrappedCallback, timer.interval);
    timer.running = true;
    clog.log(`[Timer] Started: ${id} (every ${timer.interval}ms)`);
    return true;
  }

  stop(id: string): boolean {
    const timer = this.timers.get(id);
    if (!timer) return false;

    if ((timer as { _intervalId?: NodeJS.Timeout })._intervalId) {
      clearInterval((timer as { _intervalId?: NodeJS.Timeout })._intervalId);
    }
    timer.running = false;
    clog.log(`[Timer] Stopped: ${id}`);
    return true;
  }

  stopAll(): void {
    for (const id of this.timers.keys()) {
      this.stop(id);
    }
  }

  list(): TimerHandle[] {
    return Array.from(this.timers.values());
  }
}

export const timerSystem = new TimerSystem();
