import { existsSync, readFileSync, writeFileSync } from 'fs';
import { ensureFingerLayout, getFingerPaths, resolveFingerHome, FINGER_PATHS } from '../core/finger-paths.js';

export type OrchestrationAgentRole = 'orchestrator' | 'executor' | 'reviewer' | 'searcher';

export interface OrchestrationReviewPolicy {
  enabled: boolean;
  stages?: string[];
  strictness?: string;
}

export interface OrchestrationAgentEntry {
  targetAgentId: string;
  role: OrchestrationAgentRole;
  enabled?: boolean;
  visible?: boolean;
  instanceCount?: number;
  launchMode?: 'manual' | 'orchestrator';
  targetImplementationId?: string;
  defaultQuota?: number;
  quotaPolicy?: {
    projectQuota?: number;
    workflowQuota?: Record<string, number>;
  };
}

export interface OrchestrationProfile {
  id: string;
  name: string;
  agents: OrchestrationAgentEntry[];
  reviewPolicy?: OrchestrationReviewPolicy;
}

export interface OrchestrationConfigV1 {
  version: 1;
  activeProfileId: string;
  profiles: OrchestrationProfile[];
}

export interface LoadedOrchestrationConfig {
  path: string;
  config: OrchestrationConfigV1;
  created: boolean;
}

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfigV1 = {
  version: 1,
  activeProfileId: 'default',
  profiles: [
    {
      id: 'default',
      name: 'Default Orchestration',
      reviewPolicy: {
        enabled: false,
        stages: ['execution_post'],
      },
      agents: [
        {
          targetAgentId: 'finger-orchestrator',
          role: 'orchestrator',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'orchestrator',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-researcher',
          role: 'searcher',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-executor',
          role: 'executor',
          enabled: true,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-coder',
          role: 'executor',
          enabled: false,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-reviewer',
          role: 'reviewer',
          enabled: false,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
      ],
    },
    {
      id: 'full_mock',
      name: 'Full Mock Orchestration',
      reviewPolicy: {
        enabled: false,
        stages: ['execution_post'],
      },
      agents: [
        {
          targetAgentId: 'finger-orchestrator',
          role: 'orchestrator',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'orchestrator',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-researcher',
          role: 'searcher',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-executor',
          role: 'executor',
          enabled: true,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-coder',
          role: 'executor',
          enabled: false,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-reviewer',
          role: 'reviewer',
          enabled: false,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
      ],
    },
  ],
};

export function normalizeReviewPolicy(raw: unknown): OrchestrationReviewPolicy {
  if (typeof raw !== 'object' || raw === null) {
    return { enabled: false };
  }
  const record = raw as Record<string, unknown>;
  const stages = Array.isArray(record.stages)
    ? Array.from(
        new Set(
          record.stages
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
        ),
      )
    : [];
  const strictness = typeof record.strictness === 'string' && record.strictness.trim().length > 0
    ? record.strictness.trim()
    : undefined;
  return {
    enabled: record.enabled === true,
    ...(stages.length > 0 ? { stages } : {}),
    ...(strictness ? { strictness } : {}),
  };
}

function normalizeRole(raw: unknown, targetAgentId: string): OrchestrationAgentRole {
  if (raw === 'orchestrator' || raw === 'reviewer' || raw === 'executor' || raw === 'searcher') return raw;
  const normalized = targetAgentId.toLowerCase();
  if (normalized.includes('orchestr')) return 'orchestrator';
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('search')) return 'searcher';
  return 'executor';
}

function normalizeEntry(raw: unknown): OrchestrationAgentEntry {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('orchestration agent entry must be object');
  }
  const record = raw as Record<string, unknown>;
  const targetAgentId = typeof record.targetAgentId === 'string' ? record.targetAgentId.trim() : '';
  if (!targetAgentId) {
    throw new Error('orchestration agent entry targetAgentId is required');
  }
  const role = normalizeRole(record.role, targetAgentId);
  const instanceCount = typeof record.instanceCount === 'number' && Number.isFinite(record.instanceCount)
    ? Math.max(1, Math.floor(record.instanceCount))
    : 1;
  const launchMode: 'manual' | 'orchestrator' = record.launchMode === 'orchestrator'
    ? 'orchestrator'
    : role === 'orchestrator'
      ? 'orchestrator'
      : 'manual';
  const enabled = record.enabled !== false;
  const visible = typeof record.visible === 'boolean' ? record.visible : true;
  const targetImplementationId = typeof record.targetImplementationId === 'string' && record.targetImplementationId.trim().length > 0
    ? record.targetImplementationId.trim()
    : undefined;
  const defaultQuota = typeof record.defaultQuota === 'number' && Number.isFinite(record.defaultQuota)
    ? Math.max(0, Math.floor(record.defaultQuota))
    : undefined;
  const quotaPolicyRecord = typeof record.quotaPolicy === 'object' && record.quotaPolicy !== null
    ? record.quotaPolicy as Record<string, unknown>
    : null;
  const quotaPolicy = quotaPolicyRecord
    ? (() => {
        const projectQuota = typeof quotaPolicyRecord.projectQuota === 'number' && Number.isFinite(quotaPolicyRecord.projectQuota)
          ? Math.max(0, Math.floor(quotaPolicyRecord.projectQuota))
          : undefined;
        const workflowQuota: Record<string, number> = {};
        if (typeof quotaPolicyRecord.workflowQuota === 'object' && quotaPolicyRecord.workflowQuota !== null) {
          for (const [rawId, rawQuota] of Object.entries(quotaPolicyRecord.workflowQuota as Record<string, unknown>)) {
            const workflowId = rawId.trim();
            if (!workflowId) continue;
            if (typeof rawQuota !== 'number' || !Number.isFinite(rawQuota)) continue;
            const quotaValue = Math.max(0, Math.floor(rawQuota));
            workflowQuota[workflowId] = quotaValue;
          }
        }
        return {
          ...(projectQuota !== undefined ? { projectQuota } : {}),
          ...(Object.keys(workflowQuota).length > 0 ? { workflowQuota } : {}),
        };
      })()
    : undefined;
  return {
    targetAgentId,
    role,
    enabled,
    visible,
    instanceCount,
    launchMode,
    ...(targetImplementationId ? { targetImplementationId } : {}),
    ...(defaultQuota !== undefined ? { defaultQuota } : {}),
    ...(quotaPolicy ? { quotaPolicy } : {}),
  };
}

export function resolveOrchestrationConfigPath(): string {
  const overrideHome = process.env.FINGER_HOME;
  if (typeof overrideHome === 'string' && overrideHome.trim().length > 0) {
    return getFingerPaths(resolveFingerHome()).config.file.orchestrationConfig;
  }
  return FINGER_PATHS.config.file.orchestrationConfig;
}

export function validateOrchestrationConfig(raw: unknown): OrchestrationConfigV1 {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('orchestration config must be object');
  }
  const record = raw as Record<string, unknown>;
  const version = record.version === 1
    ? 1
    : (() => { throw new Error('orchestration config version must be 1'); })();

  const legacyAgents = Array.isArray(record.agents) ? record.agents : null;
  if (legacyAgents) {
    const migrated = validateOrchestrationConfig({
      version: 1,
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Migrated',
          agents: legacyAgents,
        },
      ],
    });
    return migrated;
  }

  const profilesRaw = Array.isArray(record.profiles) ? record.profiles : [];
  if (profilesRaw.length === 0) {
    throw new Error('orchestration config requires at least one profile');
  }

  const profiles: OrchestrationProfile[] = [];
  const seenProfileIds = new Set<string>();
  for (const profileRaw of profilesRaw) {
    if (typeof profileRaw !== 'object' || profileRaw === null) {
      throw new Error('orchestration profile must be object');
    }
    const profileRecord = profileRaw as Record<string, unknown>;
    const id = typeof profileRecord.id === 'string' ? profileRecord.id.trim() : '';
    if (!id) throw new Error('orchestration profile id is required');
    if (seenProfileIds.has(id)) throw new Error(`duplicate orchestration profile id: ${id}`);
    seenProfileIds.add(id);

    const agentsRaw = Array.isArray(profileRecord.agents) ? profileRecord.agents : [];
    if (agentsRaw.length === 0) {
      throw new Error(`orchestration profile ${id} requires at least one agent`);
    }
    const agents = agentsRaw.map(normalizeEntry);
    const enabledAgents = agents.filter((item) => item.enabled !== false);
    const orchestrators = enabledAgents.filter((item) => item.role === 'orchestrator');
    if (orchestrators.length !== 1) {
      throw new Error(`orchestration profile ${id} requires exactly one enabled orchestrator agent`);
    }
    profiles.push({
      id,
      name: typeof profileRecord.name === 'string' && profileRecord.name.trim().length > 0
        ? profileRecord.name.trim()
        : id,
      agents,
      ...(profileRecord.reviewPolicy !== undefined
        ? { reviewPolicy: normalizeReviewPolicy(profileRecord.reviewPolicy) }
        : {}),
    });
  }

  const activeProfileId = typeof record.activeProfileId === 'string' ? record.activeProfileId.trim() : '';
  if (!activeProfileId) {
    throw new Error('orchestration config activeProfileId is required');
  }
  if (!profiles.some((item) => item.id === activeProfileId)) {
    throw new Error(`activeProfileId not found: ${activeProfileId}`);
  }
  return {
    version,
    activeProfileId,
    profiles,
  };
}

export function saveOrchestrationConfig(
  raw: unknown,
): LoadedOrchestrationConfig {
  ensureFingerLayout();
  const path = resolveOrchestrationConfigPath();
  const config = validateOrchestrationConfig(raw);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return {
    path,
    config,
    created: false,
  };
}

export function loadOrchestrationConfig(): LoadedOrchestrationConfig {
  ensureFingerLayout();
  const path = resolveOrchestrationConfigPath();
  if (!existsSync(path)) {
    const initial = DEFAULT_ORCHESTRATION_CONFIG;
    writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf-8');
    return {
      path,
      config: validateOrchestrationConfig(initial),
      created: true,
    };
  }
  const content = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  return {
    path,
    config: validateOrchestrationConfig(parsed),
    created: false,
  };
}
