import { loadOrchestrationConfig } from '../../orchestration/orchestration-config.js';

export type AgentDisplayRole = 'system' | 'project' | 'agent';

export interface AgentDisplayIdentity {
  id: string;
  name: string;
  role: AgentDisplayRole;
}

function normalizeAgentId(agentId: string): string {
  return typeof agentId === 'string' ? agentId.trim() : '';
}

function fallbackIdentity(agentId: string): AgentDisplayIdentity {
  const normalized = normalizeAgentId(agentId);
  if (normalized === 'finger-system-agent') {
    return { id: normalized, name: 'Mirror', role: 'system' };
  }
  // 精确匹配或前缀匹配 project agent 变体
  if (normalized === 'finger-project-agent'
    || normalized === 'finger-orchestrator'
    || normalized === 'finger-general'
    || normalized.startsWith('finger-project-agent-')
    || normalized.startsWith('finger-orchestrator-')
    || normalized.startsWith('finger-general-')) {
    return { id: normalized, name: normalized, role: 'project' };
  }
  return { id: normalized, name: normalized || 'unknown-agent', role: 'agent' };
}

export function resolveAgentDisplayIdentity(agentId: string): AgentDisplayIdentity {
  const normalized = normalizeAgentId(agentId);
  if (!normalized) return fallbackIdentity('unknown-agent');
  try {
    const loaded = loadOrchestrationConfig();
    const runtime = loaded.config.runtime;
    if (!runtime) return fallbackIdentity(normalized);

    if (normalized === runtime.systemAgent.id || normalized === 'finger-system-agent') {
      const name = typeof runtime.systemAgent.name === 'string' && runtime.systemAgent.name.trim().length > 0
        ? runtime.systemAgent.name.trim()
        : 'Mirror';
      return {
        id: normalized,
        name,
        role: 'system',
      };
    }

    const matchedWorker = runtime.projectWorkers.workers.find((worker) => worker.id === normalized);
    if (matchedWorker) {
      return {
        id: normalized,
        name: matchedWorker.name || normalized,
        role: 'project',
      };
    }

    // 前缀匹配: finger-project-agent-02 → finger-project-agent (具体 worker ID)
    const prefixMatchedWorker = runtime.projectWorkers.workers.find((worker) => {
      if (!worker.id || worker.id === 'finger-project-agent') return false;
      return normalized.startsWith(worker.id);
    });
    if (prefixMatchedWorker) {
      return {
        id: normalized,
        name: prefixMatchedWorker.name || normalized,
        role: 'project',
      };
    }

    // Generic prefix match: finger-project-agent-02 → finger-project-agent
    const genericPrefixWorker = runtime.projectWorkers.workers.find(
      (worker) => worker.id && normalized.startsWith(worker.id) && worker.id !== 'finger-project-agent'
    );
    if (genericPrefixWorker) {
      return {
        id: normalized,
        name: genericPrefixWorker.name || normalized,
        role: 'project',
      };
    }

    if (normalized === 'finger-project-agent') {
      const firstEnabledWorker = runtime.projectWorkers.workers.find((worker) => worker.enabled !== false);
      if (firstEnabledWorker?.name) {
        return {
          id: normalized,
          name: firstEnabledWorker.name,
          role: 'project',
        };
      }
      return fallbackIdentity(normalized);
    }
  } catch {
    // fall through to fallback.
  }
  return fallbackIdentity(normalized);
}

export function resolveAgentDisplayName(agentId: string): string {
  return resolveAgentDisplayIdentity(agentId).name;
}

export function normalizeAgentDisplayName(agentId: string): string {
  return resolveAgentDisplayName(agentId);
}
