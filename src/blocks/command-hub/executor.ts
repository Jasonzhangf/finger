/**
 * Command Executor - Execute commands with proper context
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command, CommandType, CommandContext, CommandResult, CommandHandler } from './types.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';
import { loadUserSettings, saveUserSettings, type AIProvider } from '../../core/user-settings.js';

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
export function loadProviderConfig(_configPath?: string): { providers: Record<string, AIProvider>; current: string | null } {
  try {
    const settings = loadUserSettings();
    return {
      providers: settings.aiProviders.providers || {},
      current: settings.aiProviders.default || null,
    };
  } catch (err) {
    log.warn('Failed to load provider config from user settings; fallback to empty providers', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { providers: {}, current: null };
  }
}

export function saveProviderConfig(_configPath: string | undefined, providerId: string): boolean {
  try {
    const settings = loadUserSettings();
    if (!settings.aiProviders.providers?.[providerId]) {
      return false;
    }
    settings.aiProviders.default = providerId;
    settings.updated_at = new Date().toISOString();
    saveUserSettings(settings);
    return true;
  } catch (err) {
    clog.error('[CommandHub] Failed to save provider config:', err);
    return false;
  }
}
