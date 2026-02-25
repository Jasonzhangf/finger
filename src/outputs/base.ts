/**
 * Output Base Interface
 */
import type { Message } from '../core/schema.js';

export interface Output {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  handle(message: Message): Promise<unknown>;
}

export abstract class BaseOutput implements Output {
  abstract id: string;
  protected running = false;

  abstract start(): Promise<void>;
  
  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  abstract handle(message: Message): Promise<unknown>;
}

