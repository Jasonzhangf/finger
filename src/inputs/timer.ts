/**
 * Timer Input - interval-based input
 */
import { BaseInput } from './base.js';
import { createMessage } from '../core/schema.js';

export interface TimerConfig {
  interval: number; // seconds
  type: string;
  payload: unknown;
}

export class TimerInput extends BaseInput {
  id: string;
  private config: TimerConfig;
  private timer: NodeJS.Timeout | null = null;

  constructor(id: string, config: TimerConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    
    const tick = async () => {
      if (this.emit) {
        await this.emit(createMessage(this.config.type, this.config.payload, this.id));
      }
    };

    await tick();
    this.timer = setInterval(tick, this.config.interval * 1000);
    this.running = true;
    console.log(`[Input:${this.id}] Timer started (${this.config.interval}s)`);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }
}
