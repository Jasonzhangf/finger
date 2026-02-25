/**
 * Finger Core Daemon - Supervisor
 * 
 * Crash recovery with exponential backoff
 */

export interface SupervisedProcess {
  id: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isHealthy: () => boolean;
}

export class Supervisor {
  private restartAttempts: Map<string, number> = new Map();
  private restartTimers: Map<string, NodeJS.Timeout> = new Map();
  private processes: Map<string, SupervisedProcess> = new Map();

  register(process: SupervisedProcess): void {
    this.processes.set(process.id, process);
    this.restartAttempts.set(process.id, 0);
  }

  unregister(id: string): void {
    this.processes.delete(id);
    this.restartAttempts.delete(id);
    const timer = this.restartTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(id);
    }
  }

  async startAll(): Promise<void> {
    for (const [id, proc] of this.processes) {
      try {
        await proc.start();
        this.restartAttempts.set(id, 0);
      } catch (err) {
        console.error(`[Supervisor] Failed to start ${id}:`, err);
        this.scheduleRestart(id);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const [id] of this.restartTimers) {
      clearTimeout(this.restartTimers.get(id)!);
    }
    this.restartTimers.clear();

    for (const [id, proc] of this.processes) {
      try {
        await proc.stop();
      } catch (err) {
        console.error(`[Supervisor] Failed to stop ${id}:`, err);
      }
    }
  }

  checkHealth(): void {
    for (const [id, proc] of this.processes) {
      if (!proc.isHealthy()) {
        console.log(`[Supervisor] Process ${id} unhealthy, scheduling restart`);
        this.scheduleRestart(id);
      } else {
        // Reset attempts on healthy check
        this.restartAttempts.set(id, 0);
      }
    }
  }

  private scheduleRestart(id: string): void {
    const attempts = this.restartAttempts.get(id) || 0;
    const delay = Math.min(1000 * Math.pow(2, attempts), 60000); // Max 60s

    console.log(`[Supervisor] Restart ${id} in ${delay}ms (attempt ${attempts + 1})`);

    this.restartAttempts.set(id, attempts + 1);

    const timer = setTimeout(async () => {
      const proc = this.processes.get(id);
      if (proc) {
        try {
          await proc.start();
          // Reset on successful start after delay
          setTimeout(() => {
            if (proc.isHealthy()) {
              this.restartAttempts.set(id, 0);
            }
          }, 5000);
        } catch (err) {
          console.error(`[Supervisor] Restart failed for ${id}:`, err);
          this.scheduleRestart(id);
        }
      }
      this.restartTimers.delete(id);
    }, delay);

    this.restartTimers.set(id, timer);
  }

  getStats(): Record<string, { attempts: number }> {
    const stats: Record<string, { attempts: number }> = {};
    for (const [id, attempts] of this.restartAttempts) {
      stats[id] = { attempts };
    }
    return stats;
  }
}

export const supervisor = new Supervisor();
