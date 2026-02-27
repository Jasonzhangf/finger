import { useCallback, useEffect, useState } from 'react';

export interface AgentRuntimeInstance {
  id: string;
  agentId: string;
  name: string;
  type: 'executor' | 'reviewer' | 'orchestrator';
  status: 'idle' | 'running' | 'error' | 'paused';
  sessionId?: string;
  workflowId?: string;
  totalDeployments: number;
}

export interface AgentRuntimePanelAgent {
  id: string;
  name: string;
  type: 'executor' | 'reviewer' | 'orchestrator';
  status: 'idle' | 'running' | 'error' | 'paused';
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  lastSessionId?: string;
  capabilities?: {
    summary: {
      role: string;
      source: string;
      status: 'idle' | 'running' | 'error' | 'paused';
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
}

interface UseAgentRuntimePanelResult {
  agents: AgentRuntimePanelAgent[];
  instances: AgentRuntimeInstance[];
  configs: AgentConfigSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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
  if (raw === 'reviewer' || raw === 'orchestrator') return raw;
  return 'executor';
}

function parseAgentStatus(raw: unknown): AgentRuntimeInstance['status'] {
  if (raw === 'running' || raw === 'error' || raw === 'paused') return raw;
  return 'idle';
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
    const instanceCount = typeof item.instanceCount === 'number' && Number.isFinite(item.instanceCount)
      ? Math.max(0, Math.floor(item.instanceCount))
      : 0;
    const deployedCount = typeof item.deployedCount === 'number' && Number.isFinite(item.deployedCount)
      ? Math.max(0, Math.floor(item.deployedCount))
      : 0;
    const availableCount = typeof item.availableCount === 'number' && Number.isFinite(item.availableCount)
      ? Math.max(0, Math.floor(item.availableCount))
      : 0;
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
    const instanceCount = typeof item.instanceCount === 'number' && Number.isFinite(item.instanceCount)
      ? Math.max(0, Math.floor(item.instanceCount))
      : 0;
    const deployedCount = typeof item.deployedCount === 'number' && Number.isFinite(item.deployedCount)
      ? Math.max(0, Math.floor(item.deployedCount))
      : 0;
    const availableCount = typeof item.availableCount === 'number' && Number.isFinite(item.availableCount)
      ? Math.max(0, Math.floor(item.availableCount))
      : 0;
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
    parsed.push({
      id,
      name,
      filePath,
      ...(role ? { role } : {}),
      ...(tools ? { tools } : {}),
    });
  }
  return parsed;
}

export function useAgentRuntimePanel(): UseAgentRuntimePanelResult {
  const [agents, setAgents] = useState<AgentRuntimePanelAgent[]>([]);
  const [instances, setInstances] = useState<AgentRuntimeInstance[]>([]);
  const [configs, setConfigs] = useState<AgentConfigSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [runtimeResponse, catalogResponse] = await Promise.all([
        fetch('/api/v1/agents/runtime-view'),
        fetch('/api/v1/agents/catalog?layer=full'),
      ]);
      if (!runtimeResponse.ok) {
        throw new Error(`加载 Agent Runtime 失败: HTTP ${runtimeResponse.status}`);
      }
      const runtimeData = await runtimeResponse.json();
      const catalogData = catalogResponse.ok ? await catalogResponse.json() : null;
      const runtimeAgents = parseRuntimeAgents(isRecord(runtimeData) ? runtimeData.agents : undefined);
      const catalogAgents = parseCatalogAgents(catalogData);
      setAgents(mergeAgents(runtimeAgents, catalogAgents));
      setInstances(parseRuntimeInstances(isRecord(runtimeData) ? runtimeData.instances : undefined));
      setConfigs(parseAgentConfigs(runtimeData));
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '加载 Agent 面板数据失败');
    } finally {
      setIsLoading(false);
    }
  }, []);

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
    isLoading,
    error,
    refresh,
    controlAgent,
  };
}
