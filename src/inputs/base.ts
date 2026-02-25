/**
 * Input Base Interface
 */
import type { Message } from '../core/schema.js';

export interface Input {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

export type MessageEmitter = (message: Message) => Promise<void>;

export abstract class BaseInput implements Input {
  abstract id: string;
  protected running = false;
  protected emit: MessageEmitter | null = null;

  setEmitter(emitter: MessageEmitter): void {
    this.emit = emitter;
  }

  abstract start(): Promise<void>;
  
  async stop(): Promise<void> {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
