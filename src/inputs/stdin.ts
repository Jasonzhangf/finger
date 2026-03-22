/**
 * Stdin Input - CLI input
 */
import { BaseInput } from './base.js';
import { createMessage } from '../core/schema.js';
import readline from 'readline';
import { logger } from '../core/logger.js';

const log = logger.module('Stdin');

export class StdinInput extends BaseInput {
  id = "stdin";
  private rl: readline.Interface | null = null;

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "finger> "
    });

    this.rl.on("line", async (line) => {
      if (!line.trim()) return;
      if (this.emit) {
        await this.emit(createMessage("cli", { text: line }, this.id));
      }
    });

    this.rl.prompt();
    this.running = true;
    log.info('Started');
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.running = false;
  }
}
