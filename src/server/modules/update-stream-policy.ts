import fs from 'node:fs';
import path from 'node:path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';

const log = logger.module('UpdateStreamPolicy');

export type UpdateStreamGranularity = 'off' | 'milestone' | 'tool' | 'reasoning' | 'full';
export type UpdateStreamSourceType = 'user' | 'heartbeat' | 'mailbox' | 'cron' | 'system-inject';
export type UpdateStreamRole = 'system' | 'project' | 'reviewer';
export type UpdateStreamSourceMode = 'all' | 'result_only' | 'silent';

export interface UpdateStreamSourcePolicy {
  mode?: UpdateStreamSourceMode;
}

export interface UpdateStreamChannelPolicy {
  enabled?: boolean;
  granularity?: UpdateStreamGranularity;
  reasoning?: boolean;
  throttleMs?: number;
}

export interface UpdateStreamRolePolicy {
  phases?: string[];
  kinds?: string[];
}

export interface UpdateStreamConfig {
  enabled?: boolean;
  defaultGranularity?: UpdateStreamGranularity;
  sourceTypePolicy?: Partial<Record<UpdateStreamSourceType, UpdateStreamSourcePolicy>>;
  channels?: Record<string, UpdateStreamChannelPolicy>;
  roles?: Partial<Record<UpdateStreamRole, UpdateStreamRolePolicy>>;
  delivery?: {
    dedupWindowMs?: number;
    retry?: {
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      strategy?: 'exponential' | string;
    };
  };
}

export interface UpdateStreamConfigResolved {
  enabled: boolean;
  defaultGranularity: UpdateStreamGranularity;
  sourceTypePolicy: Record<UpdateStreamSourceType, UpdateStreamSourcePolicy>;
  channels: Record<string, UpdateStreamChannelPolicy>;
  roles: Record<UpdateStreamRole, UpdateStreamRolePolicy>;
  delivery: {
    dedupWindowMs: number;
    retry: {
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
      strategy: 'exponential' | string;
    };
  };
}

const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'update-stream.json');
const CHECK_INTERVAL_MS = 2_000;

const DEFAULT_UPDATE_STREAM_CONFIG: UpdateStreamConfigResolved = {
  enabled: true,
  defaultGranularity: 'milestone',
  sourceTypePolicy: {
    user: { mode: 'all' },
    heartbeat: { mode: 'result_only' },
    mailbox: { mode: 'result_only' },
    cron: { mode: 'result_only' },
    'system-inject': { mode: 'result_only' },
  },
  channels: {
    qqbot: { enabled: true, granularity: 'tool', reasoning: true, throttleMs: 1500 },
    'openclaw-weixin': { enabled: true, granularity: 'milestone', reasoning: false, throttleMs: 2500 },
    webui: { enabled: true, granularity: 'full', reasoning: true, throttleMs: 0 },
  },
  roles: {
    system: {
      phases: ['dispatch', 'execution', 'review', 'delivery', 'completion'],
      kinds: ['status', 'tool', 'reasoning', 'artifact', 'decision', 'error'],
    },
    project: {
      phases: ['dispatch', 'execution', 'review', 'delivery', 'completion'],
      kinds: ['status', 'tool', 'reasoning', 'artifact', 'decision', 'error'],
    },
    reviewer: {
      phases: ['dispatch', 'execution', 'review', 'delivery', 'completion'],
      kinds: ['status', 'tool', 'reasoning', 'artifact', 'decision', 'error'],
    },
  },
  delivery: {
    dedupWindowMs: 12_000,
    retry: {
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
      strategy: 'exponential',
    },
  },
};

const DEFAULT_SOURCE_MODE: Record<UpdateStreamSourceType, UpdateStreamSourceMode> = {
  user: 'all',
  heartbeat: 'result_only',
  mailbox: 'result_only',
  cron: 'result_only',
  'system-inject': 'result_only',
};

let cache: {
  checkedAt: number;
  mtimeMs: number;
  config: UpdateStreamConfigResolved;
} | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeGranularity(value: unknown): UpdateStreamGranularity | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'off'
    || normalized === 'milestone'
    || normalized === 'tool'
    || normalized === 'reasoning'
    || normalized === 'full'
    ? normalized
    : undefined;
}

function normalizeSourceMode(value: unknown): UpdateStreamSourceMode | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized === 'all' || normalized === 'result_only' || normalized === 'silent'
    ? normalized
    : undefined;
}

function normalizeConfig(raw: unknown): UpdateStreamConfigResolved {
  const obj = asRecord(raw) ?? {};
  const sourceRaw = asRecord(obj.sourceTypePolicy) ?? {};
  const channelsRaw = asRecord(obj.channels) ?? {};
  const rolesRaw = asRecord(obj.roles) ?? {};
  const deliveryRaw = asRecord(obj.delivery) ?? {};
  const deliveryRetryRaw = asRecord(deliveryRaw.retry) ?? {};

  const normalizedChannels: Record<string, UpdateStreamChannelPolicy> = {};
  for (const [channelId, channelValue] of Object.entries(channelsRaw)) {
    const channelObj = asRecord(channelValue);
    if (!channelObj) continue;
    normalizedChannels[channelId] = {
      enabled: typeof channelObj.enabled === 'boolean' ? channelObj.enabled : undefined,
      granularity: normalizeGranularity(channelObj.granularity),
      reasoning: typeof channelObj.reasoning === 'boolean' ? channelObj.reasoning : undefined,
      throttleMs: typeof channelObj.throttleMs === 'number' && Number.isFinite(channelObj.throttleMs)
        ? Math.max(0, Math.floor(channelObj.throttleMs))
        : undefined,
    };
  }

  const normalizedRoles: Partial<Record<UpdateStreamRole, UpdateStreamRolePolicy>> = {};
  for (const role of ['system', 'project', 'reviewer'] as const) {
    const roleObj = asRecord(rolesRaw[role]);
    if (!roleObj) continue;
    normalizedRoles[role] = {
      phases: Array.isArray(roleObj.phases) ? roleObj.phases.filter((item): item is string => typeof item === 'string') : undefined,
      kinds: Array.isArray(roleObj.kinds) ? roleObj.kinds.filter((item): item is string => typeof item === 'string') : undefined,
    };
  }

  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_UPDATE_STREAM_CONFIG.enabled,
    defaultGranularity: normalizeGranularity(obj.defaultGranularity) ?? DEFAULT_UPDATE_STREAM_CONFIG.defaultGranularity,
    sourceTypePolicy: {
      user: { mode: normalizeSourceMode(asRecord(sourceRaw.user)?.mode) ?? DEFAULT_SOURCE_MODE.user },
      heartbeat: { mode: normalizeSourceMode(asRecord(sourceRaw.heartbeat)?.mode) ?? DEFAULT_SOURCE_MODE.heartbeat },
      mailbox: { mode: normalizeSourceMode(asRecord(sourceRaw.mailbox)?.mode) ?? DEFAULT_SOURCE_MODE.mailbox },
      cron: { mode: normalizeSourceMode(asRecord(sourceRaw.cron)?.mode) ?? DEFAULT_SOURCE_MODE.cron },
      'system-inject': { mode: normalizeSourceMode(asRecord(sourceRaw['system-inject'])?.mode) ?? DEFAULT_SOURCE_MODE['system-inject'] },
    },
    channels: {
      ...DEFAULT_UPDATE_STREAM_CONFIG.channels,
      ...normalizedChannels,
    },
    roles: {
      ...DEFAULT_UPDATE_STREAM_CONFIG.roles,
      ...normalizedRoles,
    },
    delivery: {
      dedupWindowMs: typeof deliveryRaw.dedupWindowMs === 'number' && Number.isFinite(deliveryRaw.dedupWindowMs)
        ? Math.max(0, Math.floor(deliveryRaw.dedupWindowMs))
        : DEFAULT_UPDATE_STREAM_CONFIG.delivery.dedupWindowMs,
      retry: {
        maxAttempts: typeof deliveryRetryRaw.maxAttempts === 'number' && Number.isFinite(deliveryRetryRaw.maxAttempts)
          ? Math.max(1, Math.floor(deliveryRetryRaw.maxAttempts))
          : DEFAULT_UPDATE_STREAM_CONFIG.delivery.retry.maxAttempts,
        baseDelayMs: typeof deliveryRetryRaw.baseDelayMs === 'number' && Number.isFinite(deliveryRetryRaw.baseDelayMs)
          ? Math.max(0, Math.floor(deliveryRetryRaw.baseDelayMs))
          : DEFAULT_UPDATE_STREAM_CONFIG.delivery.retry.baseDelayMs,
        maxDelayMs: typeof deliveryRetryRaw.maxDelayMs === 'number' && Number.isFinite(deliveryRetryRaw.maxDelayMs)
          ? Math.max(0, Math.floor(deliveryRetryRaw.maxDelayMs))
          : DEFAULT_UPDATE_STREAM_CONFIG.delivery.retry.maxDelayMs,
        strategy: typeof deliveryRetryRaw.strategy === 'string' && deliveryRetryRaw.strategy.trim().length > 0
          ? deliveryRetryRaw.strategy.trim().toLowerCase()
          : DEFAULT_UPDATE_STREAM_CONFIG.delivery.retry.strategy,
      },
    },
  };
}

function ensureConfigFileExists(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_UPDATE_STREAM_CONFIG, null, 2), 'utf-8');
    }
  } catch (error) {
    log.warn('Failed to ensure update-stream config file', {
      path: CONFIG_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function loadUpdateStreamConfigSync(force = false): UpdateStreamConfigResolved {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return normalizeConfig(DEFAULT_UPDATE_STREAM_CONFIG);
  }

  const now = Date.now();
  if (!force && cache && now - cache.checkedAt < CHECK_INTERVAL_MS) {
    return cache.config;
  }

  ensureConfigFileExists();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    mtimeMs = -1;
  }

  if (!force && cache && cache.mtimeMs === mtimeMs) {
    cache.checkedAt = now;
    return cache.config;
  }

  let parsed: unknown = null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn('Failed to read update-stream config, fallback to defaults', {
      path: CONFIG_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const config = normalizeConfig(parsed);
  cache = {
    checkedAt: now,
    mtimeMs,
    config,
  };
  return config;
}

export function inferUpdateStreamRole(agentId?: string): UpdateStreamRole {
  const normalized = typeof agentId === 'string' ? agentId.trim().toLowerCase() : '';
  if (!normalized) return 'project';
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('system')) return 'system';
  return 'project';
}

export function inferUpdateStreamSourceType(input: {
  explicit?: unknown;
  hasScheduledPolicy?: boolean;
}): UpdateStreamSourceType {
  if (typeof input.explicit === 'string' && input.explicit.trim().length > 0) {
    const normalized = input.explicit.trim().toLowerCase();
    if (normalized === 'user'
      || normalized === 'heartbeat'
      || normalized === 'mailbox'
      || normalized === 'cron'
      || normalized === 'system-inject'
    ) {
      return normalized;
    }
  }
  if (input.hasScheduledPolicy) return 'cron';
  return 'user';
}

export function resolveUpdateStreamPolicy(input: {
  channelId: string;
  role: UpdateStreamRole;
  sourceType: UpdateStreamSourceType;
  phase?: string;
  kind?: string;
}): ProgressDeliveryPolicy | undefined {
  const config = loadUpdateStreamConfigSync();
  if (!config.enabled) return undefined;

  const channelId = input.channelId.trim();
  const sourcePolicy = config.sourceTypePolicy[input.sourceType] ?? { mode: 'all' };
  const channelPolicy = config.channels[channelId];
  const rolePolicy = config.roles[input.role];
  const granularity = channelPolicy?.granularity ?? config.defaultGranularity;

  const fieldsFromGranularity: ProgressDeliveryPolicy['fields'] = granularity === 'off'
    ? {
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: false,
        toolCalls: false,
        stepUpdates: false,
        progressUpdates: false,
      }
    : granularity === 'milestone'
      ? {
          reasoning: false,
          bodyUpdates: true,
          statusUpdate: true,
          toolCalls: false,
          stepUpdates: false,
          progressUpdates: true,
        }
      : granularity === 'tool'
        ? {
            reasoning: false,
            bodyUpdates: true,
            statusUpdate: true,
            toolCalls: true,
            stepUpdates: true,
            progressUpdates: true,
          }
        : granularity === 'reasoning'
          ? {
              reasoning: true,
              bodyUpdates: true,
              statusUpdate: true,
              toolCalls: true,
              stepUpdates: true,
              progressUpdates: true,
            }
          : {
              reasoning: true,
              bodyUpdates: true,
              statusUpdate: true,
              toolCalls: true,
              stepUpdates: true,
              progressUpdates: true,
            };

  if (channelPolicy && channelPolicy.enabled === false) {
    return {
      mode: 'silent',
      fields: {
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: false,
        toolCalls: false,
        stepUpdates: false,
        progressUpdates: false,
      },
    };
  }

  const roleKinds = Array.isArray(rolePolicy?.kinds) ? rolePolicy.kinds : [];
  const rolePhases = Array.isArray(rolePolicy?.phases) ? rolePolicy.phases : [];
  const applyRoleFilters = input.sourceType !== 'user';
  const phaseHint = typeof input.phase === 'string' ? input.phase.trim().toLowerCase() : '';
  if (applyRoleFilters && phaseHint && rolePhases.length > 0 && !rolePhases.includes(phaseHint)) {
    return {
      mode: 'silent',
      fields: {
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: false,
        toolCalls: false,
        stepUpdates: false,
        progressUpdates: false,
      },
    };
  }
  const kindHint = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (applyRoleFilters && kindHint && roleKinds.length > 0 && !roleKinds.includes(kindHint)) {
    return {
      mode: 'silent',
      fields: {
        reasoning: false,
        bodyUpdates: false,
        statusUpdate: false,
        toolCalls: false,
        stepUpdates: false,
        progressUpdates: false,
      },
    };
  }
  const allowsReasoning = !applyRoleFilters || roleKinds.length === 0 || roleKinds.includes('reasoning');
  const allowsTool = !applyRoleFilters || roleKinds.length === 0 || roleKinds.includes('tool');
  const allowsStatus = !applyRoleFilters || roleKinds.length === 0 || roleKinds.includes('status') || roleKinds.includes('decision') || roleKinds.includes('error');
  const baseReasoning = typeof channelPolicy?.reasoning === 'boolean'
    ? channelPolicy.reasoning
    : (fieldsFromGranularity?.reasoning ?? false);

  const policy: ProgressDeliveryPolicy = {
    ...(sourcePolicy.mode ? { mode: sourcePolicy.mode } : {}),
    fields: {
      ...fieldsFromGranularity,
      reasoning: baseReasoning && allowsReasoning,
      toolCalls: (fieldsFromGranularity?.toolCalls ?? false) && allowsTool,
      statusUpdate: (fieldsFromGranularity?.statusUpdate ?? false) && allowsStatus,
    },
  };
  return policy;
}

export function resolveUpdateDeliveryConfig(): {
  dedupWindowMs: number;
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    strategy: 'exponential' | string;
  };
} {
  const config = loadUpdateStreamConfigSync();
  return {
    dedupWindowMs: config.delivery.dedupWindowMs,
    retry: {
      maxAttempts: config.delivery.retry.maxAttempts,
      baseDelayMs: config.delivery.retry.baseDelayMs,
      maxDelayMs: config.delivery.retry.maxDelayMs,
      strategy: config.delivery.retry.strategy,
    },
  };
}

export function resolveUpdateStreamChannelPolicy(channelId: string): UpdateStreamChannelPolicy | undefined {
  const config = loadUpdateStreamConfigSync();
  const id = channelId.trim();
  if (!id) return undefined;
  return config.channels[id];
}
