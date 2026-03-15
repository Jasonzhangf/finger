/**
 * Finger System Agent
 * System-level operations agent with isolated session storage
 */

import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

export const SYSTEM_AGENT_CONFIG = {
  id: 'finger-system-agent',
  name: 'SystemBot',
  role: 'system',
  description: '系统级操作代理',
  prefix: 'SystemBot',
  sessionPath: path.join(FINGER_PATHS.home, 'system', 'sessions'),
  projectPath: path.join(FINGER_PATHS.home, 'system'),
  capabilities: {
    readFile: true,        // Global read-only
    writeFile: false,      // Cannot write business files
    writeConfig: true,     // Can write ~/.finger/
    executeCommands: true, // Can execute system commands
  }
};

export const SYSTEM_PROJECT_PATH = SYSTEM_AGENT_CONFIG.projectPath;

/**
 * Get system agent identity info
 */
export function getSystemAgentInfo() {
  return {
    id: SYSTEM_AGENT_CONFIG.id,
    name: SYSTEM_AGENT_CONFIG.name,
    role: SYSTEM_AGENT_CONFIG.role,
    mode: 'system' as const
  };
}

/**
 * Format system agent response with prefix
 */
export function formatSystemResponse(message: string): string {
  return `${SYSTEM_AGENT_CONFIG.prefix}: ${message}`;
}

/**
 * Get system session storage path
 */
export function getSystemSessionPath(): string {
  return SYSTEM_AGENT_CONFIG.sessionPath;
}

/**
 * Check if path is within system storage
 */
export function isSystemPath(targetPath: string): boolean {
  const normalized = path.resolve(targetPath);
  const systemRoot = path.resolve(FINGER_PATHS.home, 'system');
  return normalized.startsWith(systemRoot);
}

export * from './prompt-loader.js';
export * from './registry.js';
export * from './role-manager.js';
