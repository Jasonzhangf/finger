/**
 * HubCore -> MessageHub Adapter
 * 
 * Provides compatibility layer for migrating from HubCore to MessageHub.
 * This adapter allows existing HubCore-based code (CoreDaemon) to work with
 * the unified MessageHub implementation.
 * 
 * @deprecated This adapter is temporary. Use MessageHub directly for new code.
 */

import type { Message } from './schema.js';
import { MessageHub, type MessageHandler } from '../orchestration/message-hub.js';
import { logger } from './logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('HubCoreAdapter');

const log = logger.module('HubCoreAdapter');

export type HubCoreMessageHandler = (message: Message) => Promise<unknown>;
export type HubCoreOutputHandler = (message: Message) => Promise<unknown>;

/**
 * Track registered handlers locally since MessageHub doesn't expose getId methods
 */
interface HandlerTracker {
  inputs: Set<string>;
  outputs: Set<string>;
}

/**
 * HubCoreAdapter wraps MessageHub to provide HubCore-compatible interface
 */
export class HubCoreAdapter {
  private hub: MessageHub;
  private tracker: HandlerTracker = { inputs: new Set(), outputs: new Set() };

  constructor() {
    this.hub = new MessageHub();
  }

  /**
   * Register input handler (HubCore compatible)
   */
  registerInput(id: string, handler: HubCoreMessageHandler): void {
    this.hub.registerInput(id, handler as MessageHandler, []);
    this.tracker.inputs.add(id);
    clog.log(`[HubAdapter] Input registered: ${id}`);
  }

  /**
   * Register output handler (HubCore compatible)
   */
  registerOutput(id: string, handler: HubCoreOutputHandler): void {
    this.hub.registerOutput(id, async (msg, _cb) => handler(msg as Message));
    this.tracker.outputs.add(id);
    clog.log(`[HubAdapter] Output registered: ${id}`);
  }

  /**
   * Unregister input
   */
  unregisterInput(id: string): boolean {
    const result = this.hub.unregisterInput(id);
    if (result) {
      this.tracker.inputs.delete(id);
    }
    return result;
  }

  /**
   * Unregister output
   */
  unregisterOutput(id: string): boolean {
    const result = this.hub.unregisterOutput(id);
    if (result) {
      this.tracker.outputs.delete(id);
    }
    return result;
  }

  /**
   * Route message to all matching outputs
   * Note: This is a simplified version. Full routing requires MessageHub routes.
   */
  async route(message: Message): Promise<unknown[]> {
    const results: unknown[] = [];

    // Get all registered output IDs from tracker
    const outputIds = Array.from(this.tracker.outputs);

    for (const dest of outputIds) {
      try {
        const result = await this.hub.routeToOutput(dest, message);
        results.push(result);
      } catch (err) {
        clog.error(`[HubAdapter] Output ${dest} error:`, err);
        results.push({ error: String(err), dest });
      }
    }

    return results;
  }

  /**
   * Send message directly to a specific output
   */
  async sendTo(dest: string, message: Message): Promise<unknown> {
    return this.hub.routeToOutput(dest, message);
  }

  /**
   * Get registered input IDs
   */
  getInputIds(): string[] {
    return Array.from(this.tracker.inputs);
  }

  /**
   * Get registered output IDs
   */
  getOutputIds(): string[] {
    return Array.from(this.tracker.outputs);
  }

  /**
   * Get underlying MessageHub instance
   * Use this for advanced features (routes, callbacks, etc.)
   */
  getMessageHub(): MessageHub {
    return this.hub;
  }

  /**
   * Destroy the adapter and cleanup resources
   */
  destroy(): void {
    this.tracker.inputs.clear();
    this.tracker.outputs.clear();
    // MessageHub doesn't have a clear method, unregister all instead
    for (const id of this.tracker.inputs) {
      this.hub.unregisterInput(id);
    }
    for (const id of this.tracker.outputs) {
      this.hub.unregisterOutput(id);
    }
  }
}

/**
 * Create a HubCore-compatible adapter
 */
export function createHubCoreAdapter(): HubCoreAdapter {
  return new HubCoreAdapter();
}
