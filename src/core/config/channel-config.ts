/**
 * Finger Configuration - Channel Authorization and System Commands
 *
 * Configuration structure for ~/.finger/config/config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FINGER_PATHS } from '../finger-paths.js';
import { logger } from '../../core/logger.js';
import { createConsoleLikeLogger } from '../../core/logger/console-like.js';

const clog = createConsoleLikeLogger('ChannelConfig');

const log = logger.module('ChannelConfig');

export interface ChannelAuthConfig {
  id: string;
  type: 'direct' | 'mailbox';
  priority: number;
  /** @deprecated 权限管理将迁移至 permissionMode (minimal/default/full) */

  permissionMode?: 'minimal' | 'default' | 'full';
  permissionWhitelist?: string[];
  permissionBlacklist?: string[];
  highRiskCommands?: string[];
  rejectConfig?: {
    sandboxEscalation?: boolean;
    policyRules?: boolean;
    skillApproval?: boolean;
    permissionRequest?: boolean;
    mcpElicitation?: boolean;
  };
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
  channelAutoDetail?: ChannelAutoDetailConfig;
}

export interface ChannelAutoDetailPlatformConfig {
  enabled?: boolean;
  profile?: string;
  outputRoot?: string;
  env?: string;
  maxPosts?: number;
  maxNotes?: number;
  keyword?: string;
}

export interface ChannelAutoDetailTriggerMatchConfig {
  urlHosts?: string[];
  urlHostRegex?: string[];
  containsAny?: string[];
}

export interface ChannelAutoDetailTriggerInputConfig {
  format?: 'jsonl';
  fileNamePrefix?: string;
  rowTemplate?: string;
}

export interface ChannelAutoDetailTriggerOutputConfig {
  outputRoot?: string;
}

export interface ChannelAutoDetailTriggerCommandConfig {
  bin?: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface ChannelAutoDetailTriggerRule {
  id: string;
  enabled?: boolean;
  channels?: string[];
  match?: ChannelAutoDetailTriggerMatchConfig;
  input?: ChannelAutoDetailTriggerInputConfig;
  output?: ChannelAutoDetailTriggerOutputConfig;
  command: ChannelAutoDetailTriggerCommandConfig;
}

export interface ChannelAutoDetailConfig {
  enabled?: boolean;
  channels?: string[];
  webautoBin?: string;
  webautoWorkdir?: string;
  submitTimeoutMs?: number;
  outputRoot?: string;
  triggers?: ChannelAutoDetailTriggerRule[];
  weibo?: ChannelAutoDetailPlatformConfig;
  xiaohongshu?: ChannelAutoDetailPlatformConfig;
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
        {
          id: 'webui',
          type: 'direct',
          priority: 10,
          permissionMode: 'default',
          permissionWhitelist: [],
          permissionBlacklist: [],
          highRiskCommands: ['rm -rf', 'git reset --hard', 'git checkout', 'file.delete'],
          rejectConfig: {},
        },
        {
          id: 'qqbot',
          type: 'direct',
          priority: 20,
          permissionMode: 'default',
          permissionWhitelist: [],
          permissionBlacklist: [],
          highRiskCommands: ['rm -rf', 'git reset --hard', 'git checkout', 'file.delete'],
          rejectConfig: {},
        },
        {
          id: 'cli',
          type: 'direct',
          priority: 5,
          permissionMode: 'default',
          permissionWhitelist: [],
          permissionBlacklist: [],
          highRiskCommands: ['rm -rf', 'git reset --hard', 'git checkout', 'file.delete'],
          rejectConfig: {},
        },
        {
          id: 'feishu',
          type: 'mailbox',
          priority: 30,
          permissionMode: 'default',
          permissionWhitelist: [],
          permissionBlacklist: [],
          highRiskCommands: ['rm -rf', 'git reset --hard', 'git checkout', 'file.delete'],
          rejectConfig: {},
        },
        {
          id: 'system',
          type: 'direct',
          priority: 1,
          permissionMode: 'full',
          permissionWhitelist: [],
          permissionBlacklist: [],
          highRiskCommands: [],
          rejectConfig: {},
        },
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
    channelAutoDetail: {
      enabled: true,
      channels: ['qqbot', 'openclaw-weixin'],
      webautoBin: 'webauto',
      webautoWorkdir: '~/github/webauto',
      submitTimeoutMs: 15_000,
      outputRoot: '~/.webauto/download',
      triggers: [],
      weibo: {
        enabled: true,
        profile: 'weibo',
        env: 'prod',
        maxPosts: 1,
        keyword: 'channel-link',
      },
      xiaohongshu: {
        enabled: true,
        profile: 'xiaohongshu-batch-1',
        env: 'prod',
        maxNotes: 1,
      },
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
      channelAutoDetail: {
        ...defaultConfig.channelAutoDetail,
        ...(parsed.channelAutoDetail ?? {}),
        triggers: Array.isArray(parsed.channelAutoDetail?.triggers)
          ? parsed.channelAutoDetail?.triggers
          : defaultConfig.channelAutoDetail?.triggers,
        weibo: {
          ...defaultConfig.channelAutoDetail?.weibo,
          ...(parsed.channelAutoDetail?.weibo ?? {}),
        },
        xiaohongshu: {
          ...defaultConfig.channelAutoDetail?.xiaohongshu,
          ...(parsed.channelAutoDetail?.xiaohongshu ?? {}),
        },
      },
    };
  } catch (error) {
    clog.error('[ChannelConfig] Failed to load config.json:', error);
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
 * Get channel permission mode (minimal/default/full).
 * Defaults to 'default' if not configured.
 */
export function getChannelPermissionMode(
  config: FingerConfig,
  channelId: string
): 'minimal' | 'default' | 'full' {
  const defaultMode: 'minimal' | 'default' | 'full' = 'default';
  if (!config.channelAuth?.enabled) {
    return defaultMode;
  }
  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  return channel?.permissionMode ?? defaultMode;
}

/**
 * Get channel permission whitelist.
 */
export function getChannelPermissionWhitelist(
  config: FingerConfig,
  channelId: string
): string[] {
  if (!config.channelAuth?.enabled) return [];
  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  return Array.isArray(channel?.permissionWhitelist) ? channel!.permissionWhitelist! : [];
}

/**
 * Get channel permission blacklist.
 */
export function getChannelPermissionBlacklist(
  config: FingerConfig,
  channelId: string
): string[] {
  if (!config.channelAuth?.enabled) return [];
  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  return Array.isArray(channel?.permissionBlacklist) ? channel!.permissionBlacklist! : [];
}

/**
 * Get high risk command list for channel.
 */
export function getChannelHighRiskCommands(
  config: FingerConfig,
  channelId: string
): string[] {
  if (!config.channelAuth?.enabled) return [];
  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  return Array.isArray(channel?.highRiskCommands) ? channel!.highRiskCommands! : [];
}

/**
 * Get channel reject config aligned with Codex RejectConfig.
 */
export function getChannelRejectConfig(
  config: FingerConfig,
  channelId: string
): {
  sandboxEscalation: boolean;
  policyRules: boolean;
  skillApproval: boolean;
  permissionRequest: boolean;
  mcpElicitation: boolean;
} {
  if (!config.channelAuth?.enabled) {
    return {
      sandboxEscalation: false,
      policyRules: false,
      skillApproval: false,
      permissionRequest: false,
      mcpElicitation: false,
    };
  }
  const channel = config.channelAuth.channels.find(c => c.id === channelId);
  const reject = channel?.rejectConfig ?? {};
  return {
    sandboxEscalation: reject.sandboxEscalation ?? false,
    policyRules: reject.policyRules ?? false,
    skillApproval: reject.skillApproval ?? false,
    permissionRequest: reject.permissionRequest ?? false,
    mcpElicitation: reject.mcpElicitation ?? false,
  };
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
