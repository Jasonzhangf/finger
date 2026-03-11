/**
 * System Command Authentication
 * Validates channel whitelist and optional password
 */

import * as crypto from 'crypto';
import { loadSystemCommandsConfig } from '../../core/config/system-commands-config.js';
import type { SuperCommandBlock } from './super-command-parser.js';

/**
 * Compare password with stored hash using SHA256
 */
function verifyPassword(password: string, hash: string): boolean {
  const computedHash = crypto.createHash('sha256').update(password).digest('hex');
  return computedHash === hash;
}

export async function validateSystemCommand(
  block: SuperCommandBlock,
  channel: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (block.type !== 'system') {
    return { ok: true };
  }

  const config = await loadSystemCommandsConfig();

  if (!config.enabled) {
    return { ok: false, error: 'System commands are disabled' };
  }

  // Whitelist check
  if (!config.channelWhitelist.includes(channel)) {
    return { ok: false, error: 'Channel not authorized for system commands' };
  }

  // Password check (if configured)
  if (config.password?.enabled) {
    if (!block.password) {
      return { ok: false, error: 'Password required. Use <##@system:<pwd=xxx>##>' };
    }
    
    const hash = config.password.hash;
    if (!hash || hash.length === 0) {
      return { ok: false, error: 'Password not configured properly' };
    }

    const valid = verifyPassword(block.password, hash);
    if (!valid) {
      return { ok: false, error: 'Invalid password' };
    }
  }

  return { ok: true };
}
