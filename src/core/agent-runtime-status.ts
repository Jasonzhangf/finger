import { logger } from './logger.js';

const log = logger.module('AgentRuntimeStatus');

export function isBusyAgentRuntimeStatus(status: string | undefined | null): boolean {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  return normalized === 'running'
    || normalized === 'queued'
    || normalized === 'waiting_input'
    || normalized === 'paused'
    || normalized === 'dispatching'
    || normalized === 'retrying';
}

export function extractAgentStatusFromRuntimeView(
  snapshot: unknown,
  agentId: string,
): { busy: boolean | null; status?: string } {
  if (!snapshot || typeof snapshot !== 'object') {
    return { busy: null };
  }
  const agents = Array.isArray((snapshot as { agents?: unknown }).agents)
    ? (snapshot as { agents: Array<Record<string, unknown>> }).agents
    : [];
  const agent = agents.find((item) => typeof item.id === 'string' && item.id === agentId);
  if (!agent) {
    return { busy: null };
  }
  const status = typeof agent.status === 'string' ? agent.status.trim() : '';
  return {
    busy: isBusyAgentRuntimeStatus(status),
    ...(status ? { status } : {}),
  };
}

export async function fetchAgentBusyState(
  baseUrl: string,
  agentId: string,
): Promise<{ busy: boolean | null; status?: string }> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  if (!normalizedBaseUrl || !agentId.trim()) {
    return { busy: null };
  }

  try {
    const response = await fetch(`${normalizedBaseUrl}/api/v1/agents/runtime-view`);
    if (!response.ok) {
      log.warn('[AgentRuntimeStatus] Failed to fetch runtime view', {
        agentId,
        status: response.status,
      });
      return { busy: null };
    }
    const snapshot = await response.json();
    return extractAgentStatusFromRuntimeView(snapshot, agentId);
  } catch (error) {
    log.warn('[AgentRuntimeStatus] Runtime view lookup failed', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { busy: null };
  }
}
