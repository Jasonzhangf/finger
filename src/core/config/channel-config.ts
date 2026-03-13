/**
 * Finger Configuration - Channel Authorization and System Commands
 *
 * Configuration structure for ~/.finger/config/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FINGER_PATHS } from '../finger-paths.js';

export interface ChannelAuthConfig {
  id: string;
  type: 'direct' | 'mailbox';
  priority: number;
}

export interface ChannelAuthSection {
  enabled: boolean;
  defaultPolicy: 'direct' | 'mailbox';
  channels: ChannelAuthConfig[];
}

export interface SystemAuthConfig {
  enabled: boolean;
  password: string | null; // null 或 "sha256:hash"
}

export interface DefaultsConfig {
  projectPath?: string;
  useLastProject?: boolean;
}

export interface FingerConfig {
  kernel?: Record<string, unknown>;
  channelAuth?: ChannelAuthSection;
  systemAuth?: SystemAuthConfig;
  defaults?: DefaultsConfig;
}

/**
 * Load Finger config from ~/.finger/config/config.json
 */
export async function loadFingerConfig(): Promise<FingerConfig> {
  const configPath = path.join(FINGER_PATHS.config.dir, 'config.json');

  const defaultConfig: FingerConfig = {
    channelAuth: {
      enabled: true,
      defaultPolicy: 'direct',
      channels: [
        { id: 'webui', type: 'direct', priority: 10 },
        { id: 'qqbot', type: 'direct', priority: 20 },
        { id: 'cli', type: 'direct', priority: 5 },
        { id: 'feishu', type: 'mailbox', priority: 30 },
      ],
    },
    systemAuth: {
      enabled: true,
      password: null,
    },
    defaults: {
      projectPath: '~/.finger',
      useLastProject: true,
    },
  };

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<FingerConfig>;
    return {
      ...defaultConfig,
      ...parsed,
      channelAuth: {
        enabled: parsed.channelAuth?.enabled ?? defaultConfig.channelAuth!.enabled,
        defaultPolicy: parsed.channelAuth?.defaultPolicy ?? defaultConfig.channelAuth!.defaultPolicy,
        channels: parsed.channelAuth?.channels ?? defaultConfig.channelAuth!.channels,
      },
      systemAuth: {
        enabled: parsed.systemAuth?.enabled ?? defaultConfig.systemAuth!.enabled,
        password: parsed.systemAuth?.password ?? defaultConfig.systemAuth!.password,
      },
      defaults: {
        ...defaultConfig.defaults,
        ...parsed.defaults,
      },
    };
  } catch (error) {
    console.error('[ChannelConfig] Failed to load config.json:', error);
    return defaultConfig;
  }
}

/**
 * Get channel policy (direct or mailbox) for a given channel ID
 */
export function getChannelAuth(
  config: FingerConfig,
  channelId: string
): 'direct' | 'mailbox' {
  if (!config.channelAuth?.enabled) {
    return config.channelAuth?.defaultPolicy || 'direct';
  }

  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  return channel?.type || config.channelAuth.defaultPolicy || 'direct';
}

/**
 * Resolve default project path
 * Priority: config.projectPath > last accessed project > ~/.finger
 */
export function resolveDefaultProject(
  config: FingerConfig,
  lastAccessedProjectPath: string | null
): string {
  // 1. Config priority
  if (config.defaults?.projectPath) {
    const configured = config.defaults.projectPath;
    return resolveHomePath(configured);
  }

  // 2. Last accessed project
  if (config.defaults?.useLastProject !== false && lastAccessedProjectPath) {
    return lastAccessedProjectPath;
  }

  // 3. Default ~/.finger
  return path.join(os.homedir(), '.finger');
}

/**
 * Resolve ~ in path to home directory
 */
export function resolveHomePath(inputPath: string): string {
  if (typeof inputPath !== 'string') return inputPath;
  if (inputPath.startsWith('~/')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}
