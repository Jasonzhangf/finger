import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { ensureFingerLayout, getFingerPaths, resolveFingerHome, FINGER_PATHS } from '../core/finger-paths.js';

export type OrchestrationAgentRole = 'system' | 'project';

export interface OrchestrationReviewPolicy {
  enabled: boolean;
  stages?: string[];
  strictness?: string;
  /**
   * Dispatch review mode:
   * - off: do not auto-review project dispatch completion
   * - always: every system -> project dispatch completion must go through reviewer
   */
  dispatchReviewMode?: 'off' | 'always';
}

export interface OrchestrationAgentEntry {
  targetAgentId: string;
  role: OrchestrationAgentRole;
  enabled?: boolean;
  visible?: boolean;
  instanceCount?: number;
  launchMode?: 'manual' | 'system';
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
  runtime?: OrchestrationRuntimeConfig;
}

export interface RuntimeSystemAgentConfig {
  id: string;
  name: string;
  maxInstances: 1;
}

export interface RuntimeWorkerConfig {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RuntimeProjectWorkersConfig {
  maxWorkers: number;
  autoNameOnFirstAssign: boolean;
  nameCandidates: string[];
  workers: RuntimeWorkerConfig[];
}

export interface OrchestrationRuntimeConfig {
  systemAgent: RuntimeSystemAgentConfig;
  projectWorkers: RuntimeProjectWorkersConfig;
}

export interface LoadedOrchestrationConfig {
  path: string;
  config: OrchestrationConfigV1;
  created: boolean;
}

const DEFAULT_WORKER_NAME_CANDIDATES = [
  'Alex', 'Maya', 'Leo', 'Nora', 'Iris',
  'Ethan', 'Luna', 'Owen', 'Zoe', 'Noah',
  'Mila', 'Ryan', 'Ava', 'Eli', 'Ruby',
  'Liam', 'Aria', 'Jack', 'Emma', 'Kai',
];

const DEFAULT_SYSTEM_AGENT_ID = 'finger-system-agent';
const DEFAULT_SYSTEM_AGENT_NAME = 'Mirror';
const DEFAULT_PROJECT_WORKER_ID = 'finger-project-agent';

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfigV1 = {
  version: 1,
  activeProfileId: 'default',
  runtime: {
    systemAgent: {
      id: DEFAULT_SYSTEM_AGENT_ID,
      name: DEFAULT_SYSTEM_AGENT_NAME,
      maxInstances: 1,
    },
    projectWorkers: {
      maxWorkers: 6,
      autoNameOnFirstAssign: true,
      nameCandidates: [...DEFAULT_WORKER_NAME_CANDIDATES],
      workers: [
        {
          id: DEFAULT_PROJECT_WORKER_ID,
          name: 'Alex',
          enabled: true,
        },
      ],
    }
  },
  profiles: [
    {
      id: 'default',
      name: 'Default Orchestration',
      reviewPolicy: {
        enabled: false,
        stages: ['execution_post'],
        dispatchReviewMode: 'off',
      },
      agents: [
        {
          targetAgentId: 'finger-project-agent',
          role: 'system',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'system',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-researcher',
          role: 'project',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-executor',
          role: 'project',
          enabled: true,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-coder',
          role: 'project',
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
        dispatchReviewMode: 'off',
      },
      agents: [
        {
          targetAgentId: 'finger-project-agent',
          role: 'system',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'system',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-researcher',
          role: 'project',
          enabled: true,
          visible: true,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 1,
        },
        {
          targetAgentId: 'finger-executor',
          role: 'project',
          enabled: true,
          visible: false,
          instanceCount: 1,
          launchMode: 'manual',
          defaultQuota: 0,
        },
        {
          targetAgentId: 'finger-coder',
          role: 'project',
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
    return { enabled: false, dispatchReviewMode: 'off' };
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
  const dispatchReviewMode = record.dispatchReviewMode === 'always'
    || record.dispatch_review_mode === 'always'
    ? 'always'
    : 'off';
  return {
    enabled: record.enabled === true,
    ...(stages.length > 0 ? { stages } : {}),
    ...(strictness ? { strictness } : {}),
    dispatchReviewMode,
  };
}

function normalizeRole(raw: unknown, targetAgentId: string): OrchestrationAgentRole {
  if (raw === 'system' || raw === 'project') return raw;
  const normalized = targetAgentId.toLowerCase();
  if (normalized.includes('system')) return 'system';
  if (normalized.includes('review')) return 'system';
  if (normalized.includes('orchestr')) return 'system';
  if (normalized.includes('project')) return 'project';
  return 'project';
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
  const launchMode: 'manual' | 'system' = record.launchMode === 'system'
    ? 'system'
    : role === 'system'
      ? 'system'
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

function normalizeNonEmptyString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveInteger(raw: unknown, fallback: number, minimum = 1): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(minimum, Math.floor(raw));
}

function ensureUniqueCaseInsensitive(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate ${label}: ${value}`);
    }
    seen.add(key);
  }
}

function pickUniqueFallbackName(usedNames: Set<string>): string {
  let sequence = usedNames.size + 1;
  while (sequence < usedNames.size + 10000) {
    const candidate = `Worker-${String(sequence).padStart(2, '0')}`;
    const key = candidate.toLowerCase();
    if (!usedNames.has(key)) return candidate;
    sequence += 1;
  }
  return `Worker-${Date.now()}`;
}

function assignMissingWorkerNames(
  workers: RuntimeWorkerConfig[],
  candidates: string[],
): RuntimeWorkerConfig[] {
  const usedNames = new Set<string>();
  for (const worker of workers) {
    const normalized = worker.name.trim().toLowerCase();
    if (normalized.length > 0) usedNames.add(normalized);
  }

  return workers.map((worker) => {
    const existingName = worker.name.trim();
    if (existingName.length > 0) return worker;
    let resolvedName = '';
    for (const candidate of candidates) {
      const normalized = candidate.toLowerCase();
      if (usedNames.has(normalized)) continue;
      resolvedName = candidate;
      usedNames.add(normalized);
      break;
    }
    if (!resolvedName) {
      resolvedName = pickUniqueFallbackName(usedNames);
      usedNames.add(resolvedName.toLowerCase());
    }
    return {
      ...worker,
      name: resolvedName,
    };
  });
}

function inferRuntimeAnchorIds(
  profiles: OrchestrationProfile[],
  activeProfileId: string,
): {
  systemAgentId: string;
  workerAgentId: string;
  reviewerAgentId?: string;
} {
  const active = profiles.find((item) => item.id === activeProfileId);
  const enabledAgents = active?.agents?.filter((item) => item.enabled !== false) ?? [];
  const orchestrator = enabledAgents.find((item) => item.role === 'system');
  const worker = enabledAgents.find((item) => item.role === 'project')
    ?? enabledAgents.find((item) => item.targetAgentId.toLowerCase().includes('project'));
  // Reviewer absorbed into system agent - no separate reviewer role

  return {
    systemAgentId: orchestrator?.targetAgentId || DEFAULT_SYSTEM_AGENT_ID,
    workerAgentId: worker?.targetAgentId || DEFAULT_PROJECT_WORKER_ID,
    reviewerAgentId: undefined,
  };
}

function normalizeRuntimeConfig(
  rawRuntime: unknown,
  profiles: OrchestrationProfile[],
  activeProfileId: string,
): OrchestrationRuntimeConfig {
  const anchors = inferRuntimeAnchorIds(profiles, activeProfileId);
  const runtimeRecord = typeof rawRuntime === 'object' && rawRuntime !== null
    ? rawRuntime as Record<string, unknown>
    : {};

  const systemRecord = typeof runtimeRecord.systemAgent === 'object' && runtimeRecord.systemAgent !== null
    ? runtimeRecord.systemAgent as Record<string, unknown>
    : {};
  const systemAgentId = normalizeNonEmptyString(systemRecord.id) || anchors.systemAgentId;
  const systemAgentName = normalizeNonEmptyString(systemRecord.name) || DEFAULT_SYSTEM_AGENT_NAME;
  const systemAgent: RuntimeSystemAgentConfig = {
    id: systemAgentId,
    name: systemAgentName,
    maxInstances: 1,
  };

  const projectWorkersRecord = typeof runtimeRecord.projectWorkers === 'object' && runtimeRecord.projectWorkers !== null
    ? runtimeRecord.projectWorkers as Record<string, unknown>
    : {};
  const maxWorkers = normalizePositiveInteger(projectWorkersRecord.maxWorkers, 6, 1);
  const autoNameOnFirstAssign = projectWorkersRecord.autoNameOnFirstAssign !== false;
  const nameCandidatesRaw = Array.isArray(projectWorkersRecord.nameCandidates)
    ? projectWorkersRecord.nameCandidates
    : DEFAULT_WORKER_NAME_CANDIDATES;
  const nameCandidates = Array.from(
    new Set(
      nameCandidatesRaw
        .map((item) => normalizeNonEmptyString(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );
  const normalizedCandidates = nameCandidates.length > 0
    ? nameCandidates
    : [...DEFAULT_WORKER_NAME_CANDIDATES];

  const workersRaw = Array.isArray(projectWorkersRecord.workers) ? projectWorkersRecord.workers : [];
  const workersBase = workersRaw.length > 0
    ? workersRaw.map((item, index): RuntimeWorkerConfig => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`runtime.projectWorkers.workers[${index}] must be object`);
      }
      const record = item as Record<string, unknown>;
      const id = normalizeNonEmptyString(record.id);
      if (!id) {
        throw new Error(`runtime.projectWorkers.workers[${index}].id is required`);
      }
      return {
        id,
        name: normalizeNonEmptyString(record.name) || '',
        enabled: record.enabled !== false,
      };
    })
    : [
      {
        id: anchors.workerAgentId,
        name: '',
        enabled: true,
      },
    ];
  if (workersBase.length > maxWorkers) {
    throw new Error(`runtime.projectWorkers.workers exceeds maxWorkers=${maxWorkers}`);
  }
  ensureUniqueCaseInsensitive(workersBase.map((item) => item.id), 'worker id');
  const workers = autoNameOnFirstAssign
    ? assignMissingWorkerNames(workersBase, normalizedCandidates)
    : workersBase.map((item) => ({ ...item, name: item.name.trim() }));
  const nonEmptyWorkerNames = workers.map((item) => item.name.trim()).filter((item) => item.length > 0);
  ensureUniqueCaseInsensitive(nonEmptyWorkerNames, 'worker name');

  return {
    systemAgent,
    projectWorkers: {
      maxWorkers,
      autoNameOnFirstAssign,
      nameCandidates: normalizedCandidates,
      workers,
    },
  };
}

function writeConfigFileAtomic(path: string, config: OrchestrationConfigV1): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, path);
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
    const orchestrators = enabledAgents.filter((item) => item.role === 'system');
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
  const runtime = normalizeRuntimeConfig(record.runtime, profiles, activeProfileId);
  return {
    version,
    activeProfileId,
    profiles,
    runtime,
  };
}

export function saveOrchestrationConfig(
  raw: unknown,
): LoadedOrchestrationConfig {
  ensureFingerLayout();
  const path = resolveOrchestrationConfigPath();
  const config = validateOrchestrationConfig(raw);
  writeConfigFileAtomic(path, config);
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
    const validated = validateOrchestrationConfig(initial);
    writeConfigFileAtomic(path, validated);
    return {
      path,
      config: validated,
      created: true,
    };
  }
  const content = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  const config = validateOrchestrationConfig(parsed);
  const normalizedSource = JSON.stringify(parsed);
  const normalizedTarget = JSON.stringify(config);
  if (normalizedSource !== normalizedTarget) {
    writeConfigFileAtomic(path, config);
  }
  return {
    path,
    config,
    created: false,
  };
}
