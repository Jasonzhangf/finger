import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from './finger-paths.js';
import { logger } from './logger.js';

const log = logger.module('SystemDispatchPolicy');

const SYSTEM_DISPATCH_POLICY_PATH = path.join(FINGER_PATHS.config.dir, 'system-dispatch-policy.json');
const CACHE_TTL_MS = 2_000;

interface RawSystemDispatchPolicyConfig {
  routeSystemDispatchToMailboxByDefault?: boolean;
  directInject?: {
    sourceAgentIds?: string[];
    metadataSources?: string[];
    deliveryModes?: string[];
    metadataFlags?: string[];
  };
}

export interface SystemDispatchPolicy {
  routeSystemDispatchToMailboxByDefault: boolean;
  directInjectSourceAgentIds: Set<string>;
  directInjectMetadataSources: Set<string>;
  directInjectDeliveryModes: Set<string>;
  directInjectMetadataFlags: Set<string>;
}

const DEFAULT_POLICY: SystemDispatchPolicy = {
  routeSystemDispatchToMailboxByDefault: true,
  directInjectSourceAgentIds: new Set(['system-direct-injector']),
  directInjectMetadataSources: new Set<string>(),
  directInjectDeliveryModes: new Set(['direct']),
  directInjectMetadataFlags: new Set(['systemdirectinject', 'directinject']),
};

let cachedPolicy: SystemDispatchPolicy = DEFAULT_POLICY;
let cachedAt = 0;
let cachedMtimeMs: number | null = null;

function normalizeStringSet(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set<string>();
  const normalized = values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  return new Set(normalized);
}

function resolvePolicyFromRaw(raw: RawSystemDispatchPolicyConfig | null | undefined): SystemDispatchPolicy {
  const directInject = raw?.directInject;
  return {
    routeSystemDispatchToMailboxByDefault: raw?.routeSystemDispatchToMailboxByDefault !== false,
    directInjectSourceAgentIds: (() => {
      const configured = normalizeStringSet(directInject?.sourceAgentIds);
      return configured.size > 0 ? configured : new Set(DEFAULT_POLICY.directInjectSourceAgentIds);
    })(),
    directInjectMetadataSources: normalizeStringSet(directInject?.metadataSources),
    directInjectDeliveryModes: (() => {
      const configured = normalizeStringSet(directInject?.deliveryModes);
      return configured.size > 0 ? configured : new Set(DEFAULT_POLICY.directInjectDeliveryModes);
    })(),
    directInjectMetadataFlags: (() => {
      const configured = normalizeStringSet(directInject?.metadataFlags);
      return configured.size > 0 ? configured : new Set(DEFAULT_POLICY.directInjectMetadataFlags);
    })(),
  };
}

function loadPolicyFromDisk(): { policy: SystemDispatchPolicy; mtimeMs: number | null } {
  try {
    if (!fs.existsSync(SYSTEM_DISPATCH_POLICY_PATH)) {
      return { policy: DEFAULT_POLICY, mtimeMs: null };
    }
    const stat = fs.statSync(SYSTEM_DISPATCH_POLICY_PATH);
    const raw = fs.readFileSync(SYSTEM_DISPATCH_POLICY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as RawSystemDispatchPolicyConfig;
    return { policy: resolvePolicyFromRaw(parsed), mtimeMs: stat.mtimeMs };
  } catch (error) {
    log.warn('[SystemDispatchPolicy] Failed to load policy config, using defaults', {
      path: SYSTEM_DISPATCH_POLICY_PATH,
      error: error instanceof Error ? error.message : String(error),
    });
    return { policy: DEFAULT_POLICY, mtimeMs: null };
  }
}

export function resolveSystemDispatchPolicy(): SystemDispatchPolicy {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) {
    return cachedPolicy;
  }

  const loaded = loadPolicyFromDisk();
  if (loaded.mtimeMs === cachedMtimeMs && now - cachedAt < CACHE_TTL_MS * 5) {
    cachedAt = now;
    return cachedPolicy;
  }

  cachedPolicy = loaded.policy;
  cachedMtimeMs = loaded.mtimeMs;
  cachedAt = now;
  return cachedPolicy;
}

