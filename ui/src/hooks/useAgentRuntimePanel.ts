import { useCallback, useEffect, useState } from 'react';

type AgentRuntimeStatus =
  | 'idle'
  | 'running'
  | 'error'
  | 'paused'
  | 'queued'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'interrupted';
type AgentType = 'executor' | 'reviewer' | 'orchestrator' | 'searcher';
type QuotaSource = 'workflow' | 'project' | 'default' | 'deployment';

export interface AgentQuotaPolicy {
  projectQuota?: number;
  workflowQuota: Record<string, number>;
}

export interface AgentQuotaView {
  effective: number;
  source: QuotaSource;
  workflowId?: string;
}

export interface AgentLastEvent {
  type: 'dispatch' | 'control' | 'status';
  status: string;
  summary: string;
  timestamp: string;
  sessionId?: string;
  workflowId?: string;
  dispatchId?: string;
}

export interface AgentDebugAssertion {
  id: string;
  timestamp: string;
  agentId: string;
  agentRole: 'executor' | 'reviewer' | 'searcher';
  sessionId?: string;
  workflowId?: string;
  taskId?: string;
  content: string;
  payload: unknown;
  result: {
    ok: boolean;
    summary: string;
  };
}

export interface AgentRuntimeInstance {
  id: string;
  agentId: string;
  name: string;
  type: AgentType;
  status: AgentRuntimeStatus;
  sessionId?: string;
  workflowId?: string;
  totalDeployments: number;
}

export interface AgentRuntimePanelAgent {
  id: string;
  name: string;
  type: AgentType;
  status: AgentRuntimeStatus;
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  runningCount: number;
  queuedCount: number;
  enabled: boolean;
  runtimeCapabilities: string[];
  defaultQuota: number;
  quotaPolicy: AgentQuotaPolicy;
  quota: AgentQuotaView;
  lastEvent?: AgentLastEvent;
  debugAssertions: AgentDebugAssertion[];
  lastSessionId?: string;
  capabilities?: {
    summary: {
      role: string;
      source: string;
      status: AgentRuntimeStatus;
      tags: string[];
    };
    execution?: {
      exposedTools: string[];
      dispatchTargets: string[];
      supportsDispatch: boolean;
      supportsControl: Array<'status' | 'pause' | 'resume' | 'interrupt' | 'cancel'>;
    };
    governance?: {
      whitelist: string[];
      blacklist: string[];
      authorizationRequired: string[];
      provider?: string;
      sessionBindingScope?: string;
      iflowApprovalMode?: string;
      capabilityIds?: string[];
    };
  };
}

export interface AgentConfigSummary {
  id: string;
  name: string;
  role?: string;
  filePath: string;
  tools?: Record<string, unknown>;
  enabled?: boolean;
  capabilities?: string[];
  defaultQuota?: number;
  quotaPolicy?: AgentQuotaPolicy;
}

export interface AgentStartupImplementation {
  id: string;
  kind: 'iflow' | 'native';
  status: 'available' | 'unavailable';
  moduleId?: string;
  provider?: string;
}

export interface AgentStartupTarget {
  id: string;
  name: string;
  role: AgentType;
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  tags: string[];
  implementations: AgentStartupImplementation[];
}

export interface AgentStartupTemplate {
  id: string;
  name: string;
  role: AgentType;
  defaultImplementationId: string;
  defaultModuleId: string;
  defaultInstanceCount: number;
  launchMode: 'manual' | 'orchestrator';
}

export interface OrchestrationProfileConfig {
  id: string;
  name: string;
  reviewPolicy?: {
    enabled: boolean;
    stages: string[];
    strictness?: string;
  };
  agents: Array<{
    targetAgentId: string;
    role: AgentType;
    enabled: boolean;
    visible?: boolean;
    instanceCount: number;
    launchMode: 'manual' | 'orchestrator';
    targetImplementationId?: string;
    defaultQuota?: number;
    quotaPolicy?: AgentQuotaPolicy;
  }>;
}

export interface OrchestrationConfigState {
  version: 1;
  activeProfileId: string;
  profiles: OrchestrationProfileConfig[];
}

interface UseAgentRuntimePanelResult {
  agents: AgentRuntimePanelAgent[];
  instances: AgentRuntimeInstance[];
  configs: AgentConfigSummary[];
  startupTargets: AgentStartupTarget[];
  startupTemplates: AgentStartupTemplate[];
  orchestrationConfig: OrchestrationConfigState | null;
  debugAssertions: AgentDebugAssertion[];
  debugMode: boolean;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setDebugMode: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; error?: string }>;
  startTemplate: (payload: {
    templateId: string;
    sessionId?: string;
    instanceCount?: number;
  }) => Promise<{ ok: boolean; error?: string }>;
  saveOrchestrationConfig: (config: unknown) => Promise<{ ok: boolean; error?: string }>;
  switchOrchestrationProfile: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  controlAgent: (payload: {
    action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel';
    targetAgentId?: string;
    sessionId?: string;
    workflowId?: string;
    providerId?: string;
    hard?: boolean;
  }) => Promise<{
    ok: boolean;
    action?: string;
    status?: string;
    result?: unknown;
    error?: string;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseAgentType(raw: unknown): AgentRuntimeInstance['type'] {
  if (raw === 'reviewer' || raw === 'orchestrator' || raw === 'searcher') return raw;
  if (raw === 'executor') return raw;
  return 'executor';
}

function parseAgentStatus(raw: unknown): AgentRuntimeStatus {
  if (typeof raw !== 'string') return 'idle';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'running'
    || normalized === 'error'
    || normalized === 'paused'
    || normalized === 'queued'
    || normalized === 'waiting_input'
    || normalized === 'completed'
    || normalized === 'failed'
    || normalized === 'interrupted'
  ) {
    return normalized as AgentRuntimeStatus;
  }
  if (
    normalized === 'busy'
    || normalized === 'deployed'
    || normalized === 'starting'
    || normalized === 'active'
    || normalized === 'in_progress'
    || normalized === 'executing'
    || normalized === 'allocated'
  ) {
    return 'running';
  }
  if (normalized === 'blocked') {
    return 'error';
  }
  return 'idle';
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.floor(raw));
}

function parseNonNegativeInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.floor(raw));
}

function parseQuotaPolicy(raw: unknown): AgentQuotaPolicy {
  if (!isRecord(raw)) return { workflowQuota: {} };
  const workflowQuotaRaw = isRecord(raw.workflowQuota) ? raw.workflowQuota : {};
  const workflowQuota: Record<string, number> = {};
  for (const [workflowId, quota] of Object.entries(workflowQuotaRaw)) {
    const trimmedId = workflowId.trim();
    if (trimmedId.length === 0) continue;
    if (typeof quota !== 'number' || !Number.isFinite(quota)) continue;
    workflowQuota[trimmedId] = Math.max(0, Math.floor(quota));
  }
  return {
    ...(typeof raw.projectQuota === 'number' && Number.isFinite(raw.projectQuota)
      ? { projectQuota: Math.max(0, Math.floor(raw.projectQuota)) }
      : {}),
    workflowQuota,
  };
}

function parseQuotaView(raw: unknown, defaultQuota = 1): AgentQuotaView {
  if (!isRecord(raw)) {
    return { effective: Math.max(0, defaultQuota), source: 'default' };
  }
  const source: QuotaSource = raw.source === 'workflow' || raw.source === 'project' || raw.source === 'deployment'
    ? raw.source
    : 'default';
  const effective = typeof raw.effective === 'number' && Number.isFinite(raw.effective)
    ? Math.max(0, Math.floor(raw.effective))
    : Math.max(0, defaultQuota);
  const workflowId = typeof raw.workflowId === 'string' && raw.workflowId.trim().length > 0
    ? raw.workflowId.trim()
    : undefined;
  return {
    effective,
    source,
    ...(workflowId ? { workflowId } : {}),
  };
}

function parseLastEvent(raw: unknown): AgentLastEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const type = raw.type === 'dispatch' || raw.type === 'control' || raw.type === 'status'
    ? raw.type
    : undefined;
  if (!type) return undefined;
  const status = typeof raw.status === 'string' && raw.status.trim().length > 0 ? raw.status.trim() : '';
  const summary = typeof raw.summary === 'string' && raw.summary.trim().length > 0 ? raw.summary.trim() : '';
  const timestamp = typeof raw.timestamp === 'string' && raw.timestamp.trim().length > 0
    ? raw.timestamp.trim()
    : '';
  if (!status || !summary || !timestamp) return undefined;
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId.trim() : undefined;
  const workflowId = typeof raw.workflowId === 'string' && raw.workflowId.trim().length > 0 ? raw.workflowId.trim() : undefined;
  const dispatchId = typeof raw.dispatchId === 'string' && raw.dispatchId.trim().length > 0 ? raw.dispatchId.trim() : undefined;
  return {
    type,
    status,
    summary,
    timestamp,
    ...(sessionId ? { sessionId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(dispatchId ? { dispatchId } : {}),
  };
}

function parseRuntimeInstances(raw: unknown): AgentRuntimeInstance[] {
  if (!Array.isArray(raw)) return [];
  const parsed: AgentRuntimeInstance[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : '';
    if (id.length === 0) continue;
    if (agentId.length === 0) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const type = parseAgentType(item.type);
    const status = parseAgentStatus(item.status);
    const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim().length > 0 ? item.sessionId.trim() : undefined;
    const workflowId = typeof item.workflowId === 'string' && item.workflowId.trim().length > 0 ? item.workflowId.trim() : undefined;
    parsed.push({
      id,
      agentId,
      name,
      type,
      status,
      ...(sessionId ? { sessionId } : {}),
      ...(workflowId ? { workflowId } : {}),
      totalDeployments: 1,
    });
  }
  return parsed;
}

function parseRuntimeAgents(raw: unknown): AgentRuntimePanelAgent[] {
  if (!Array.isArray(raw)) return [];
  const parsed: AgentRuntimePanelAgent[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const source = item.source === 'agent-json' || item.source === 'runtime-config' || item.source === 'module' || item.source === 'deployment'
      ? item.source
      : 'runtime-config';
    const instanceCount = parseNonNegativeInt(item.instanceCount, 0);
    const deployedCount = parseNonNegativeInt(item.deployedCount, 0);
    const availableCount = parseNonNegativeInt(item.availableCount, 0);
    const runningCount = parseNonNegativeInt(item.runningCount, 0);
    const queuedCount = parseNonNegativeInt(item.queuedCount, 0);
    const enabled = item.enabled !== false;
    const runtimeCapabilities = toStringArray(item.capabilities);
    const defaultQuota = parseNonNegativeInt(item.defaultQuota, 1);
    const quotaPolicy = parseQuotaPolicy(item.quotaPolicy);
    const quota = parseQuotaView(item.quota, defaultQuota);
    const lastEvent = parseLastEvent(item.lastEvent);
    const lastSessionId = typeof item.lastSessionId === 'string' && item.lastSessionId.trim().length > 0
      ? item.lastSessionId.trim()
      : undefined;
    parsed.push({
      id,
      name,
      type: parseAgentType(item.type),
      status: parseAgentStatus(item.status),
      source,
      instanceCount,
      deployedCount,
      availableCount,
      runningCount,
      queuedCount,
      enabled,
      runtimeCapabilities,
      defaultQuota,
      quotaPolicy,
      quota,
      ...(lastEvent ? { lastEvent } : {}),
      debugAssertions: [],
      ...(lastSessionId ? { lastSessionId } : {}),
    });
  }
  return parsed;
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseCatalogAgents(raw: unknown): AgentRuntimePanelAgent[] {
  if (!isRecord(raw) || !Array.isArray(raw.agents)) return [];
  const parsed: AgentRuntimePanelAgent[] = [];
  for (const item of raw.agents) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const source = item.source === 'agent-json' || item.source === 'runtime-config' || item.source === 'module' || item.source === 'deployment'
      ? item.source
      : 'runtime-config';
    const instanceCount = parseNonNegativeInt(item.instanceCount, 0);
    const deployedCount = parseNonNegativeInt(item.deployedCount, 0);
    const availableCount = parseNonNegativeInt(item.availableCount, 0);
    const runningCount = parseNonNegativeInt(item.runningCount, 0);
    const queuedCount = parseNonNegativeInt(item.queuedCount, 0);
    const enabled = item.enabled !== false;
    const runtimeCapabilities = toStringArray(item.runtimeCapabilities);
    const defaultQuota = parseNonNegativeInt(item.defaultQuota, 1);
    const quotaPolicy = parseQuotaPolicy(item.quotaPolicy);
    const quota = parseQuotaView(item.quota, defaultQuota);
    const lastEvent = parseLastEvent(item.lastEvent);
    const lastSessionId = typeof item.lastSessionId === 'string' && item.lastSessionId.trim().length > 0
      ? item.lastSessionId.trim()
      : undefined;

    const rawCapabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
    const rawSummary = rawCapabilities && isRecord(rawCapabilities.summary) ? rawCapabilities.summary : undefined;
    const rawExecution = rawCapabilities && isRecord(rawCapabilities.execution) ? rawCapabilities.execution : undefined;
    const rawGovernance = rawCapabilities && isRecord(rawCapabilities.governance) ? rawCapabilities.governance : undefined;

    const capabilities = rawSummary
      ? {
          summary: {
            role: typeof rawSummary.role === 'string' ? rawSummary.role : parseAgentType(item.type),
            source: typeof rawSummary.source === 'string' ? rawSummary.source : source,
            status: parseAgentStatus(rawSummary.status),
            tags: toStringArray(rawSummary.tags),
          },
          ...(rawExecution
            ? {
                execution: {
                  exposedTools: toStringArray(rawExecution.exposedTools),
                  dispatchTargets: toStringArray(rawExecution.dispatchTargets),
                  supportsDispatch: rawExecution.supportsDispatch === true,
                  supportsControl: toStringArray(rawExecution.supportsControl)
                    .filter(
                      (item): item is 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel' =>
                        item === 'status' || item === 'pause' || item === 'resume' || item === 'interrupt' || item === 'cancel',
                    ),
                },
              }
            : {}),
          ...(rawGovernance
            ? {
                governance: {
                  whitelist: toStringArray(rawGovernance.whitelist),
                  blacklist: toStringArray(rawGovernance.blacklist),
                  authorizationRequired: toStringArray(rawGovernance.authorizationRequired),
                  ...(typeof rawGovernance.provider === 'string' ? { provider: rawGovernance.provider } : {}),
                  ...(typeof rawGovernance.sessionBindingScope === 'string'
                    ? { sessionBindingScope: rawGovernance.sessionBindingScope }
                    : {}),
                  ...(typeof rawGovernance.iflowApprovalMode === 'string'
                    ? { iflowApprovalMode: rawGovernance.iflowApprovalMode }
                    : {}),
                  ...(Array.isArray(rawGovernance.capabilityIds)
                    ? { capabilityIds: toStringArray(rawGovernance.capabilityIds) }
                    : {}),
                },
              }
            : {}),
        }
      : undefined;

    parsed.push({
      id,
      name,
      type: parseAgentType(item.type),
      status: parseAgentStatus(item.status),
      source,
      instanceCount,
      deployedCount,
      availableCount,
      runningCount,
      queuedCount,
      enabled,
      runtimeCapabilities,
      defaultQuota,
      quotaPolicy,
      quota,
      ...(lastEvent ? { lastEvent } : {}),
      debugAssertions: [],
      ...(lastSessionId ? { lastSessionId } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return parsed;
}

function mergeAgents(
  runtimeAgents: AgentRuntimePanelAgent[],
  catalogAgents: AgentRuntimePanelAgent[],
): AgentRuntimePanelAgent[] {
  const map = new Map<string, AgentRuntimePanelAgent>();
  for (const item of catalogAgents) {
    map.set(item.id, { ...item });
  }
  for (const item of runtimeAgents) {
    const existing = map.get(item.id);
    if (!existing) {
      map.set(item.id, { ...item });
      continue;
    }
    map.set(item.id, {
      ...existing,
      ...item,
      capabilities: existing.capabilities ?? item.capabilities,
    });
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

const DEFAULT_VISIBLE_AGENT_IDS = new Set(['finger-orchestrator', 'finger-researcher']);

function filterVisibleAgents(
  agents: AgentRuntimePanelAgent[],
  orchestration: OrchestrationConfigState | null,
): AgentRuntimePanelAgent[] {
  if (!orchestration) {
    return agents.filter((agent) => DEFAULT_VISIBLE_AGENT_IDS.has(agent.id));
  }
  const activeProfile = orchestration.profiles.find((profile) => profile.id === orchestration.activeProfileId);
  if (!activeProfile) {
    return agents.filter((agent) => DEFAULT_VISIBLE_AGENT_IDS.has(agent.id));
  }
  const visibleByConfig = new Set(
    activeProfile.agents
      .filter((entry) => entry.visible !== false)
      .map((entry) => entry.targetAgentId),
  );
  return agents.filter((agent) => visibleByConfig.has(agent.id));
}

function parseAgentConfigs(raw: unknown): AgentConfigSummary[] {
  if (!isRecord(raw) || !Array.isArray(raw.configs)) return [];
  const parsed: AgentConfigSummary[] = [];
  for (const item of raw.configs) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (id.length === 0) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const filePath = typeof item.filePath === 'string' ? item.filePath : '';
    const role = typeof item.role === 'string' && item.role.trim().length > 0 ? item.role.trim() : undefined;
    const tools = isRecord(item.tools) ? item.tools : undefined;
    const enabled = typeof item.enabled === 'boolean' ? item.enabled : undefined;
    const capabilities = Array.isArray(item.capabilities) ? toStringArray(item.capabilities) : undefined;
    const defaultQuota = typeof item.defaultQuota === 'number' && Number.isFinite(item.defaultQuota)
      ? Math.max(0, Math.floor(item.defaultQuota))
      : undefined;
    const quotaPolicy = item.quotaPolicy !== undefined ? parseQuotaPolicy(item.quotaPolicy) : undefined;
    parsed.push({
      id,
      name,
      filePath,
      ...(role ? { role } : {}),
      ...(tools ? { tools } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(defaultQuota !== undefined ? { defaultQuota } : {}),
      ...(quotaPolicy ? { quotaPolicy } : {}),
    });
  }
  return parsed;
}

function parseDebugAssertions(raw: unknown): { assertions: AgentDebugAssertion[]; debugMode: boolean } {
  if (!isRecord(raw) || !Array.isArray(raw.assertions)) {
    return { assertions: [], debugMode: false };
  }

  const assertions: AgentDebugAssertion[] = [];
  for (const item of raw.assertions) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const timestamp = typeof item.timestamp === 'string' ? item.timestamp.trim() : '';
    const agentId = typeof item.agentId === 'string' ? item.agentId.trim() : '';
    const agentRole =
      item.agentRole === 'reviewer'
        ? 'reviewer'
        : item.agentRole === 'executor'
          ? 'executor'
          : item.agentRole === 'searcher'
            ? 'searcher'
            : null;
    const content = typeof item.content === 'string' ? item.content : '';
    if (!id || !timestamp || !agentId || !agentRole || !content) continue;
    const sessionId = typeof item.sessionId === 'string' && item.sessionId.trim().length > 0 ? item.sessionId.trim() : undefined;
    const workflowId = typeof item.workflowId === 'string' && item.workflowId.trim().length > 0 ? item.workflowId.trim() : undefined;
    const taskId = typeof item.taskId === 'string' && item.taskId.trim().length > 0 ? item.taskId.trim() : undefined;
    const result = isRecord(item.result) ? item.result : {};
    const ok = result.ok !== false;
    const summary = typeof result.summary === 'string' && result.summary.trim().length > 0
      ? result.summary.trim()
      : ok ? 'ok' : 'error';
    assertions.push({
      id,
      timestamp,
      agentId,
      agentRole,
      ...(sessionId ? { sessionId } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(taskId ? { taskId } : {}),
      content,
      payload: item.payload,
      result: {
        ok,
        summary,
      },
    });
  }

  return {
    assertions,
    debugMode: raw.debugMode === true,
  };
}

function bindDebugAssertions(
  agents: AgentRuntimePanelAgent[],
  assertions: AgentDebugAssertion[],
): AgentRuntimePanelAgent[] {
  const byAgent = new Map<string, AgentDebugAssertion[]>();
  for (const assertion of assertions) {
    const list = byAgent.get(assertion.agentId) ?? [];
    list.push(assertion);
    byAgent.set(assertion.agentId, list);
  }
  return agents.map((agent) => ({
    ...agent,
    debugAssertions: byAgent.get(agent.id) ?? [],
  }));
}

function parseStartupTargets(raw: unknown): AgentStartupTarget[] {
  if (!Array.isArray(raw)) return [];
  const parsed: AgentStartupTarget[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const role = parseAgentType(item.role);
    const source = item.source === 'agent-json' || item.source === 'module' || item.source === 'deployment'
      ? item.source
      : 'runtime-config';
    const tags = toStringArray(item.tags);
    const implementationsRaw = Array.isArray(item.implementations) ? item.implementations : [];
    const implementations: AgentStartupImplementation[] = implementationsRaw
      .filter(isRecord)
      .map((impl) => {
        const implId = typeof impl.id === 'string' ? impl.id.trim() : '';
        if (!implId) return null;
        const kind: AgentStartupImplementation['kind'] = impl.kind === 'iflow' ? 'iflow' : 'native';
        const status: AgentStartupImplementation['status'] = impl.status === 'unavailable' ? 'unavailable' : 'available';
        const moduleId = typeof impl.moduleId === 'string' && impl.moduleId.trim().length > 0 ? impl.moduleId.trim() : undefined;
        const provider = typeof impl.provider === 'string' && impl.provider.trim().length > 0 ? impl.provider.trim() : undefined;
        return {
          id: implId,
          kind,
          status,
          ...(moduleId ? { moduleId } : {}),
          ...(provider ? { provider } : {}),
        };
      })
      .filter((impl): impl is AgentStartupImplementation => impl !== null);
    parsed.push({
      id,
      name,
      role,
      source,
      tags,
      implementations,
    });
  }
  return parsed.sort((a, b) => a.name.localeCompare(b.name));
}

function parseStartupTemplates(raw: unknown): AgentStartupTemplate[] {
  if (!Array.isArray(raw)) return [];
  const parsed: AgentStartupTemplate[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) continue;
    const name = typeof item.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id;
    const defaultImplementationId =
      typeof item.defaultImplementationId === 'string' && item.defaultImplementationId.trim().length > 0
        ? item.defaultImplementationId.trim()
        : '';
    const defaultModuleId =
      typeof item.defaultModuleId === 'string' && item.defaultModuleId.trim().length > 0
        ? item.defaultModuleId.trim()
        : '';
    if (!defaultImplementationId || !defaultModuleId) continue;
    const launchMode: AgentStartupTemplate['launchMode'] = item.launchMode === 'orchestrator' ? 'orchestrator' : 'manual';
    parsed.push({
      id,
      name,
      role: parseAgentType(item.role),
      defaultImplementationId,
      defaultModuleId,
      defaultInstanceCount: parsePositiveInt(item.defaultInstanceCount, 1),
      launchMode,
    });
  }
  return parsed.sort((a, b) => a.name.localeCompare(b.name));
}

function parseDebugMode(raw: unknown): boolean | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.enabled === 'boolean') return raw.enabled;
  return undefined;
}

function parseReviewPolicy(raw: unknown): OrchestrationProfileConfig['reviewPolicy'] | undefined {
  if (!isRecord(raw)) return undefined;
  const stages = Array.isArray(raw.stages)
    ? raw.stages
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
  const strictness = typeof raw.strictness === 'string' && raw.strictness.trim().length > 0
    ? raw.strictness.trim()
    : undefined;
  return {
    enabled: raw.enabled === true,
    stages,
    ...(strictness ? { strictness } : {}),
  };
}

function parseOrchestrationConfig(raw: unknown): OrchestrationConfigState | null {
  if (!isRecord(raw) || !isRecord(raw.config)) return null;
  const configRaw = raw.config;
  if (configRaw.version !== 1) return null;
  const activeProfileId = typeof configRaw.activeProfileId === 'string' ? configRaw.activeProfileId.trim() : '';
  if (!activeProfileId) return null;
  const profilesRaw = Array.isArray(configRaw.profiles) ? configRaw.profiles : [];
  const profiles: OrchestrationProfileConfig[] = [];
  for (const profile of profilesRaw) {
    if (!isRecord(profile)) continue;
    const id = typeof profile.id === 'string' ? profile.id.trim() : '';
    if (!id) continue;
    const name = typeof profile.name === 'string' && profile.name.trim().length > 0 ? profile.name.trim() : id;
    const agentsRaw = Array.isArray(profile.agents) ? profile.agents : [];
    const agents: OrchestrationProfileConfig['agents'] = [];
    for (const agent of agentsRaw) {
      if (!isRecord(agent)) continue;
      const targetAgentId = typeof agent.targetAgentId === 'string' ? agent.targetAgentId.trim() : '';
      if (!targetAgentId) continue;
      const role = parseAgentType(agent.role);
      const instanceCount = parsePositiveInt(agent.instanceCount, 1);
      const launchMode: 'manual' | 'orchestrator' = agent.launchMode === 'orchestrator' ? 'orchestrator' : 'manual';
      const enabled = agent.enabled !== false;
      const visible = typeof agent.visible === 'boolean' ? agent.visible : undefined;
      const defaultQuota = parseNonNegativeInt(agent.defaultQuota, 1);
      const quotaPolicy = agent.quotaPolicy !== undefined ? parseQuotaPolicy(agent.quotaPolicy) : undefined;
      const targetImplementationId =
        typeof agent.targetImplementationId === 'string' && agent.targetImplementationId.trim().length > 0
          ? agent.targetImplementationId.trim()
          : undefined;
      agents.push({
        targetAgentId,
        role,
        enabled,
        instanceCount,
        launchMode,
        ...(visible !== undefined ? { visible } : {}),
        ...(targetImplementationId ? { targetImplementationId } : {}),
        ...(defaultQuota !== undefined ? { defaultQuota } : {}),
        ...(quotaPolicy ? { quotaPolicy } : {}),
      });
    }
    const reviewPolicy = parseReviewPolicy(profile.reviewPolicy);
    profiles.push({
      id,
      name,
      agents,
      ...(reviewPolicy ? { reviewPolicy } : {}),
    });
  }
  if (profiles.length === 0) return null;
  return {
    version: 1,
    activeProfileId,
    profiles,
  };
}

export function useAgentRuntimePanel(): UseAgentRuntimePanelResult {
  const [agents, setAgents] = useState<AgentRuntimePanelAgent[]>([]);
  const [instances, setInstances] = useState<AgentRuntimeInstance[]>([]);
  const [configs, setConfigs] = useState<AgentConfigSummary[]>([]);
  const [startupTargets, setStartupTargets] = useState<AgentStartupTarget[]>([]);
  const [startupTemplates, setStartupTemplates] = useState<AgentStartupTemplate[]>([]);
  const [orchestrationConfig, setOrchestrationConfig] = useState<OrchestrationConfigState | null>(null);
  const [debugAssertions, setDebugAssertions] = useState<AgentDebugAssertion[]>([]);
  const [debugMode, setDebugModeState] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [runtimeResponse, catalogResponse, debugResponse, debugModeResponse, orchestrationResponse] = await Promise.all([
        fetch('/api/v1/agents/runtime-view'),
        fetch('/api/v1/agents/catalog?layer=full'),
        fetch('/api/v1/agents/debug/assertions?limit=120'),
        fetch('/api/v1/agents/debug/mode'),
        fetch('/api/v1/orchestration/config'),
      ]);
      if (!runtimeResponse.ok) {
        throw new Error(`加载 Agent Runtime 失败: HTTP ${runtimeResponse.status}`);
      }
      const runtimeData = await runtimeResponse.json();
      const catalogData = catalogResponse.ok ? await catalogResponse.json() : null;
      const debugData = debugResponse.ok ? await debugResponse.json() : null;
      const debugModeData = debugModeResponse.ok ? await debugModeResponse.json() : null;
      const orchestrationData = orchestrationResponse.ok ? await orchestrationResponse.json() : null;
      const runtimeAgents = parseRuntimeAgents(isRecord(runtimeData) ? runtimeData.agents : undefined);
      const catalogAgents = parseCatalogAgents(catalogData);
      const parsedDebug = parseDebugAssertions(debugData);
      const parsedDebugMode = parseDebugMode(debugModeData);
      const mergedAgents = mergeAgents(runtimeAgents, catalogAgents);
      const parsedOrchestration = parseOrchestrationConfig(orchestrationData);
      const visibleAgents = filterVisibleAgents(mergedAgents, parsedOrchestration);
      setAgents(bindDebugAssertions(visibleAgents, parsedDebug.assertions));
      setInstances(parseRuntimeInstances(isRecord(runtimeData) ? runtimeData.instances : undefined));
      setConfigs(parseAgentConfigs(runtimeData));
      setStartupTargets(parseStartupTargets(isRecord(runtimeData) ? runtimeData.startupTargets : undefined));
      setStartupTemplates(parseStartupTemplates(isRecord(runtimeData) ? runtimeData.startupTemplates : undefined));
      setOrchestrationConfig(parsedOrchestration);
      setDebugAssertions(parsedDebug.assertions);
      setDebugModeState(parsedDebugMode ?? parsedDebug.debugMode);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '加载 Agent 面板数据失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setDebugMode = useCallback(async (enabled: boolean): Promise<{ ok: boolean; enabled: boolean; error?: string }> => {
    try {
      const response = await fetch('/api/v1/agents/debug/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errorMessage = typeof data.error === 'string'
          ? data.error
          : `更新 debug mode 失败: HTTP ${response.status}`;
        return { ok: false, enabled: debugMode, error: errorMessage };
      }
      const resolvedEnabled = data.enabled === true;
      setDebugModeState(resolvedEnabled);
      await refresh();
      return { ok: true, enabled: resolvedEnabled };
    } catch (requestError) {
      const errorMessage = requestError instanceof Error ? requestError.message : '更新 debug mode 失败';
      return { ok: false, enabled: debugMode, error: errorMessage };
    }
  }, [debugMode, refresh]);

  const startTemplate = useCallback(async (payload: {
    templateId: string;
    sessionId?: string;
    instanceCount?: number;
  }): Promise<{ ok: boolean; error?: string }> => {
    const templateId = payload.templateId.trim();
    const template = startupTemplates.find((item) => item.id === templateId);
    if (!template) {
      return { ok: false, error: `未找到启动模板: ${templateId}` };
    }
    const instanceCount = Number.isFinite(payload.instanceCount)
      ? Math.max(1, Math.floor(payload.instanceCount!))
      : template.defaultInstanceCount;
    try {
      const response = await fetch('/api/v1/agents/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
            ? { sessionId: payload.sessionId.trim() }
            : {}),
          scope: 'session',
          targetAgentId: template.id,
          targetImplementationId: template.defaultImplementationId,
          launchMode: template.launchMode,
          instanceCount,
          config: {
            id: template.id,
            name: template.name,
            role: template.role,
          },
        }),
      });
      if (!response.ok) {
        const message = await response.text().catch(() => `HTTP ${response.status}`);
        return { ok: false, error: message || `HTTP ${response.status}` };
      }
      await refresh();
      return { ok: true };
    } catch (requestError) {
      return { ok: false, error: requestError instanceof Error ? requestError.message : '模板启动失败' };
    }
  }, [refresh, startupTemplates]);

  const saveOrchestrationConfig = useCallback(async (config: unknown): Promise<{ ok: boolean; error?: string }> => {
    try {
      const response = await fetch('/api/v1/orchestration/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ok: false,
          error: typeof data.error === 'string' ? data.error : `保存 orchestration 配置失败: HTTP ${response.status}`,
        };
      }
      await refresh();
      return { ok: true };
    } catch (requestError) {
      return { ok: false, error: requestError instanceof Error ? requestError.message : '保存 orchestration 配置失败' };
    }
  }, [refresh]);

  const switchOrchestrationProfile = useCallback(async (profileId: string): Promise<{ ok: boolean; error?: string }> => {
    const normalized = profileId.trim();
    if (!normalized) {
      return { ok: false, error: 'profileId is required' };
    }
    try {
      const response = await fetch('/api/v1/orchestration/config/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: normalized }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return {
          ok: false,
          error: typeof data.error === 'string' ? data.error : `切换 orchestration profile 失败: HTTP ${response.status}`,
        };
      }
      await refresh();
      return { ok: true };
    } catch (requestError) {
      return { ok: false, error: requestError instanceof Error ? requestError.message : '切换 orchestration profile 失败' };
    }
  }, [refresh]);

  const controlAgent = useCallback(async (payload: {
    action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel';
    targetAgentId?: string;
    sessionId?: string;
    workflowId?: string;
    providerId?: string;
    hard?: boolean;
  }): Promise<{
    ok: boolean;
    action?: string;
    status?: string;
    result?: unknown;
    error?: string;
  }> => {
    const response = await fetch('/api/v1/agents/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: payload.action,
        ...(payload.targetAgentId ? { targetAgentId: payload.targetAgentId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
        ...(payload.workflowId ? { workflowId: payload.workflowId } : {}),
        ...(payload.providerId ? { providerId: payload.providerId } : {}),
        ...(typeof payload.hard === 'boolean' ? { hard: payload.hard } : {}),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        action: payload.action,
        status: 'failed',
        error:
          typeof data.error === 'string'
            ? data.error
            : `agent control failed: HTTP ${response.status}`,
      };
    }
    return {
      ok: data.ok !== false,
      action: typeof data.action === 'string' ? data.action : payload.action,
      status: typeof data.status === 'string' ? data.status : 'completed',
      ...(data.result !== undefined ? { result: data.result } : {}),
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
    };
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return {
    agents,
    instances,
    configs,
    startupTargets,
    startupTemplates,
    orchestrationConfig,
    debugAssertions,
    debugMode,
    isLoading,
    error,
    refresh,
    setDebugMode,
    startTemplate,
    saveOrchestrationConfig,
    switchOrchestrationProfile,
    controlAgent,
  };
}
