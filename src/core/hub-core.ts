/**
 * Finger Core Daemon - Hub Core
 * 
 * Message routing with pattern matching
 */

import type { Registry } from './registry-new.js';
import type { Message } from './schema.js';

export type MessageHandler = (message: Message) => Promise<unknown>;
export type OutputHandler = (message: Message) => Promise<unknown>;

export class HubCore {
  private inputs: Map<string, MessageHandler> = new Map();
  private outputs: Map<string, OutputHandler> = new Map();

  constructor(private registry: Registry) {}

  // Register input handler
  registerInput(id: string, handler: MessageHandler): void {
    this.inputs.set(id, handler);
    console.log(`[Hub] Input registered: ${id}`);
  }

  // Register output handler
  registerOutput(id: string, handler: OutputHandler): void {
    this.outputs.set(id, handler);
    console.log(`[Hub] Output registered: ${id}`);
  }

  // Unregister
  unregisterInput(id: string): boolean {
    return this.inputs.delete(id);
  }

  unregisterOutput(id: string): boolean {
    return this.outputs.delete(id);
  }

  // Route message to destinations
  async route(message: Message): Promise<unknown[]> {
    const destinations = this.registry.matchRoutes(message);
    const results: unknown[] = [];

    for (const dest of destinations) {
      const handler = this.outputs.get(dest);
      if (handler) {
        try {
          const result = await handler({
            ...message,
            meta: { ...message.meta, dest },
          });
          results.push(result);
        } catch (err) {
          console.error(`[Hub] Output ${dest} error:`, err);
          results.push({ error: String(err), dest });
        }
      } else {
        console.warn(`[Hub] Output not found: ${dest}`);
      }
    }

    return results;
  }

  // Send message directly to a specific output
  async sendTo(dest: string, message: Message): Promise<unknown> {
    const handler = this.outputs.get(dest);
    if (!handler) {
      throw new Error(`Output not found: ${dest}`);
    }
    return handler({
      ...message,
      meta: { ...message.meta, dest },
    });
  }

  // Get registered IDs
  getInputIds(): string[] {
    return Array.from(this.inputs.keys());
  }

  getOutputIds(): string[] {
    return Array.from(this.outputs.keys());
  }
}
