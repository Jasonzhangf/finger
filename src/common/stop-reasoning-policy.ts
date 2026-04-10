import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { logger } from '../core/logger.js';

export interface StopReasoningPolicyFile {
  requireToolForStop?: boolean;
  promptInjectionEnabled?: boolean;
  stopToolNames?: string[];
  maxAutoContinueTurns?: number;
}

export interface StopReasoningPolicy {
  requireToolForStop: boolean;
  promptInjectionEnabled: boolean;
  stopToolNames: string[];
  maxAutoContinueTurns: number;
  source: 'default' | 'env' | 'file' | 'metadata';
}

export const DEFAULT_STOP_REASONING_TOOL_NAME = 'reasoning.stop';
export const STOP_REASONING_POLICY_PATH = path.join(FINGER_PATHS.config.dir, 'stop-reasoning-policy.json');

const DEFAULT_POLICY: StopReasoningPolicy = {
  requireToolForStop: true,
  promptInjectionEnabled: true,
  stopToolNames: [DEFAULT_STOP_REASONING_TOOL_NAME],
  maxAutoContinueTurns: 10,
  source: 'default',
};
const log = logger.module('StopReasoningPolicy');

let cachedPolicy: StopReasoningPolicy | null = null;
let cachedAt = 0;
const POLICY_CACHE_TTL_MS = 1000;

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on' || normalized === 'enabled') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === 'disabled') return false;
  }
  return undefined;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return fallback;
}

function normalizeStopToolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return Array.from(new Set(names));
}

function buildPolicyFromUnknown(
  value: unknown,
  fallback: StopReasoningPolicy,
  source: StopReasoningPolicy['source'],
): StopReasoningPolicy {
  if (!value || typeof value !== 'object') return { ...fallback, source };
  const record = value as StopReasoningPolicyFile;
  const promptInjectionEnabled = normalizeBoolean(record.promptInjectionEnabled) ?? fallback.promptInjectionEnabled;
  const stopToolNames = normalizeStopToolNames(record.stopToolNames);
  const maxAutoContinueTurns = normalizePositiveInt(record.maxAutoContinueTurns, fallback.maxAutoContinueTurns);
  return {
    requireToolForStop: true,
    promptInjectionEnabled,
    stopToolNames: stopToolNames.length > 0 ? stopToolNames : fallback.stopToolNames,
    maxAutoContinueTurns,
    source,
  };
}

function resolveFromEnv(base: StopReasoningPolicy): StopReasoningPolicy {
  const promptInjectionEnabled = normalizeBoolean(process.env.FINGER_STOP_TOOL_PROMPT_ENABLED)
    ?? base.promptInjectionEnabled;
  const maxAutoContinueTurns = normalizePositiveInt(process.env.FINGER_STOP_TOOL_MAX_AUTO_CONTINUE, base.maxAutoContinueTurns);
  return {
    ...base,
    requireToolForStop: true,
    promptInjectionEnabled,
    maxAutoContinueTurns,
    source: 'env',
  };
}

function loadPolicyFromFileSync(base: StopReasoningPolicy): StopReasoningPolicy {
  if (!existsSync(STOP_REASONING_POLICY_PATH)) return base;
  try {
    const raw = readFileSync(STOP_REASONING_POLICY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StopReasoningPolicyFile;
    return buildPolicyFromUnknown(parsed, base, 'file');
  } catch (err) {
    log.warn('Failed to load stop-reasoning policy file; fallback to env/default policy', {
      policyPath: STOP_REASONING_POLICY_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return base;
  }
}

export function resolveStopReasoningPolicy(metadata?: Record<string, unknown>): StopReasoningPolicy {
  const now = Date.now();
  if (!cachedPolicy || now - cachedAt > POLICY_CACHE_TTL_MS) {
    const envPolicy = resolveFromEnv(DEFAULT_POLICY);
    cachedPolicy = loadPolicyFromFileSync(envPolicy);
    cachedAt = now;
  }

  if (!metadata || typeof metadata !== 'object') {
    return { ...cachedPolicy };
  }

  const hasMetadataOverride =
    metadata.stopToolNames !== undefined
    || metadata.stopToolMaxAutoContinueTurns !== undefined
    || metadata.stopToolPromptInjectionEnabled !== undefined;

  if (!hasMetadataOverride) {
    return { ...cachedPolicy };
  }

  const promptInjectionEnabled = normalizeBoolean(metadata.stopToolPromptInjectionEnabled)
    ?? cachedPolicy.promptInjectionEnabled;
  const stopToolNames = normalizeStopToolNames(metadata.stopToolNames);
  const maxAutoContinueTurns = normalizePositiveInt(
    metadata.stopToolMaxAutoContinueTurns,
    cachedPolicy.maxAutoContinueTurns,
  );

  return {
    requireToolForStop: true,
    promptInjectionEnabled,
    stopToolNames: stopToolNames.length > 0 ? stopToolNames : cachedPolicy.stopToolNames,
    maxAutoContinueTurns,
    source: 'metadata',
  };
}

export function isStopReasoningStopTool(toolName: string, stopToolNames?: string[]): boolean {
  const normalizedTool = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  if (!normalizedTool) return false;
  const names = Array.isArray(stopToolNames) && stopToolNames.length > 0
    ? stopToolNames
    : resolveStopReasoningPolicy().stopToolNames;
  return names.some((item) => item.trim().toLowerCase() === normalizedTool);
}

export async function readStopReasoningPolicyFile(): Promise<StopReasoningPolicyFile> {
  try {
    const raw = await fs.readFile(STOP_REASONING_POLICY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as StopReasoningPolicyFile;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (err) {
    log.warn('Failed to read stop-reasoning policy file; return empty object', {
      policyPath: STOP_REASONING_POLICY_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export async function writeStopReasoningPolicyFile(policy: StopReasoningPolicyFile): Promise<void> {
  await fs.mkdir(path.dirname(STOP_REASONING_POLICY_PATH), { recursive: true });
  const normalized: StopReasoningPolicyFile = {
    requireToolForStop: true,
    promptInjectionEnabled: normalizeBoolean(policy.promptInjectionEnabled) ?? DEFAULT_POLICY.promptInjectionEnabled,
    stopToolNames: normalizeStopToolNames(policy.stopToolNames),
    maxAutoContinueTurns: normalizePositiveInt(policy.maxAutoContinueTurns, DEFAULT_POLICY.maxAutoContinueTurns),
  };
  if (!normalized.stopToolNames || normalized.stopToolNames.length === 0) {
    normalized.stopToolNames = [DEFAULT_STOP_REASONING_TOOL_NAME];
  }
  await fs.writeFile(STOP_REASONING_POLICY_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  cachedPolicy = null;
  cachedAt = 0;
}
