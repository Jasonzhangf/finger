import { loadOrchestrationConfig } from '../../orchestration/orchestration-config.js';

export type AgentDisplayRole = 'system' | 'project' | 'reviewer' | 'agent';

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
  if (normalized === 'finger-project-agent' || normalized === 'finger-orchestrator' || normalized === 'finger-general') {
    return { id: normalized, name: normalized, role: 'project' };
  }
  if (normalized === 'finger-reviewer') return { id: normalized, name: normalized, role: 'reviewer' };
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

    const matchedReviewer = runtime.reviewers.agents.find((reviewer) => reviewer.id === normalized);
    if (matchedReviewer) {
      return {
        id: normalized,
        name: matchedReviewer.name || normalized,
        role: 'reviewer',
      };
    }

    if (normalized === 'finger-reviewer') {
      const firstEnabledReviewer = runtime.reviewers.agents.find((reviewer) => reviewer.enabled !== false);
      if (firstEnabledReviewer?.name) {
        return {
          id: normalized,
          name: firstEnabledReviewer.name,
          role: 'reviewer',
        };
      }
      if (runtime.reviewers.reviewerName) {
        return {
          id: normalized,
          name: runtime.reviewers.reviewerName,
          role: 'reviewer',
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
