import type {
  AgentConfigSummary,
  AgentRuntimeInstance,
  AgentRuntimePanelAgent,
} from '../../hooks/useAgentRuntimePanel.js';

interface AgentLike {
  id: string;
  name: string;
  source?: string;

  type: string;
}

export interface AgentBinding {
  agentId: string;
  agent: AgentLike | null;
  config: AgentConfigSummary | null;
  displayName: string;
}

export function formatDispatchDescriptor(input: {
  sourceAgentId?: string | null;
  sourceDisplayName?: string | null;
  targetAgentId?: string | null;
  targetDisplayName?: string | null;
  taskId?: string | null;
  status?: string | null;
}): string {
  const source = (input.sourceDisplayName && input.sourceDisplayName.trim())
    || (input.sourceAgentId && input.sourceAgentId.trim())
    || 'unknown-source';
  const target = (input.targetDisplayName && input.targetDisplayName.trim())
    || (input.targetAgentId && input.targetAgentId.trim())
    || 'unknown-target';
  const status = (input.status && input.status.trim()) || 'unknown';
  const taskId = (input.taskId && input.taskId.trim()) || '';
  return taskId
    ? `${source} -> ${target} · ${status} · task ${taskId}`
    : `${source} -> ${target} · ${status}`;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function matchInstanceToAgent(agent: AgentLike, instance: AgentRuntimeInstance): boolean {
  // 唯一真源：精确匹配agentId
  return normalize(agent.id) === normalize(instance.agentId);
}

export function findAgentById<T extends AgentLike>(agents: T[], agentId: string): T | null {
  const normalizedAgentId = normalize(agentId);
  return agents.find((item) => normalize(item.id) === normalizedAgentId) ?? null;
}

export function findConfigForAgent(agent: AgentLike, configs: AgentConfigSummary[]): AgentConfigSummary | null {
  // 唯一真源：精确匹配agentId
  const agentId = normalize(agent.id);
  return configs.find((item) => normalize(item.id) === agentId) ?? null;
}

export function findConfigByAgentId(agentId: string, configs: AgentConfigSummary[]): AgentConfigSummary | null {
  const normalizedAgentId = normalize(agentId);
  return configs.find((item) => normalize(item.id) === normalizedAgentId) ?? null;
}

export function resolveAgentDisplayName(agent: AgentLike, configs: AgentConfigSummary[]): string {
  const config = findConfigForAgent(agent, configs);
  if (config?.name && config.name.trim().length > 0) return config.name.trim();
  if (agent.name && agent.name.trim().length > 0) return agent.name.trim();
  return agent.id;
}

export function resolveInstanceDisplayName(
  instance: AgentRuntimeInstance,
  agents: AgentLike[],
  configs: AgentConfigSummary[],
): string {
  const boundAgent = findAgentById(agents, instance.agentId);
  if (boundAgent) return resolveAgentDisplayName(boundAgent, configs);
  const config = findConfigByAgentId(instance.agentId, configs);
  if (config?.name && config.name.trim().length > 0) return config.name.trim();
  if (instance.name && instance.name.trim().length > 0) return instance.name.trim();
  return instance.agentId;
}

export function resolveAgentBinding(
  agentId: string,
  agents: AgentLike[],
  configs: AgentConfigSummary[],
): AgentBinding {
  const agent = findAgentById(agents, agentId);
  const config = agent ? findConfigForAgent(agent, configs) : findConfigByAgentId(agentId, configs);
  const displayName = config?.name?.trim()
    || agent?.name?.trim()
    || agentId;
  return {
    agentId,
    agent,
    config,
    displayName,
  };
}

export function resolveInstanceBinding(
  instance: AgentRuntimeInstance,
  agents: AgentLike[],
  configs: AgentConfigSummary[],
): AgentBinding {
  return resolveAgentBinding(instance.agentId, agents, configs);
}

export function mergeAgentSources(
  configAgents: AgentRuntimePanelAgent[],
  runtimeAgents: AgentRuntimePanelAgent[],
): AgentRuntimePanelAgent[] {
  const merged = new Map<string, AgentRuntimePanelAgent>();
  for (const agent of runtimeAgents) {
    merged.set(normalize(agent.id), agent);
  }
  for (const agent of configAgents) {
    merged.set(normalize(agent.id), agent);
  }
  return Array.from(merged.values());
}

export function isActiveInstanceStatus(status: string): boolean {
  const normalized = normalize(status);
  return normalized === 'deployed'
    || normalized === 'busy'
    || normalized === 'running'
    || normalized === 'starting'
    || normalized === 'active'
    || normalized === 'executing'
    || normalized === 'in_progress'
    || normalized === 'allocated'
    || normalized === 'queued'
    || normalized === 'waiting_input'
    || normalized === 'paused';
}
