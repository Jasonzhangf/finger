/**
 * Command Executor - Execute commands with proper context
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command, CommandType, CommandContext, CommandResult, CommandHandler } from './types.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Executor');

const log = logger.module('Executor');

export class CommandExecutor {
  private handlers: Map<CommandType, CommandHandler> = new Map();

  registerHandler(type: CommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  async execute(cmd: Command, ctx: CommandContext): Promise<CommandResult> {
    const handler = this.handlers.get(cmd.type);
    
    if (!handler) {
      return {
        success: false,
        output: '',
        error: `No handler registered for command type: ${cmd.type}`
      };
    }

    try {
      return await handler.execute(cmd, ctx);
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async executeAll(commands: Command[], ctx: CommandContext): Promise<CommandResult[]> {
    const results: CommandResult[] = [];
    
    for (const cmd of commands) {
      const result = await this.execute(cmd, ctx);
      results.push(result);
      
      if (!result.success) {
        // Stop on first error
        break;
      }
    }
    
    return results;
  }
}

/**
 * Provider config utilities
 */
export function loadProviderConfig(configPath: string): { providers: Record<string, any>; current: string | null } {
  try {
    if (!fs.existsSync(configPath)) {
      return { providers: {}, current: null };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as any;
    const kernel = config?.kernel || {};
    return {
      providers: kernel.providers || {},
      current: kernel.provider || null,
    };
  } catch {
    return { providers: {}, current: null };
  }
}

export function saveProviderConfig(configPath: string, providerId: string): boolean {
  try {
    let config: any = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content);
    }
    if (!config.kernel) config.kernel = {};
    config.kernel.provider = providerId;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    clog.error('[CommandHub] Failed to save provider config:', err);
    return false;
  }
}
