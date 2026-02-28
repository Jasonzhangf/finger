import type { AgentConfigSummary, AgentRuntimeInstance } from '../../hooks/useAgentRuntimePanel.js';

interface AgentLike {
  id: string;
  name: string;
  type: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function matchInstanceToAgent(agent: AgentLike, instance: AgentRuntimeInstance): boolean {
  const agentId = normalize(agent.id);
  const agentName = normalize(agent.name);
  const instanceId = normalize(instance.id);
  const instanceName = normalize(instance.name);
  const instanceType = normalize(instance.type);
  const agentType = normalize(agent.type);

  if (instanceId === agentId || instanceName === agentName) return true;
  if (agentId.length > 0 && (instanceId.includes(agentId) || instanceName.includes(agentId))) return true;
  if (agentName.length > 0 && (instanceId.includes(agentName) || instanceName.includes(agentName))) return true;
  if (agentType.length > 0 && instanceType === agentType) return true;
  if (agentType === 'reviewer' && instanceType.includes('review')) return true;
  if (agentType === 'orchestrator' && instanceType.includes('orchestr')) return true;
  return false;
}

export function findConfigForAgent(agent: AgentLike, configs: AgentConfigSummary[]): AgentConfigSummary | null {
  const agentId = normalize(agent.id);
  const agentName = normalize(agent.name);
  const exactById = configs.find((item) => normalize(item.id) === agentId);
  if (exactById) return exactById;
  const exactByName = configs.find((item) => normalize(item.name) === agentName);
  if (exactByName) return exactByName;
  const fuzzy = configs.find((item) => {
    const id = normalize(item.id);
    const name = normalize(item.name);
    return id.includes(agentId) || name.includes(agentName) || agentId.includes(id) || agentName.includes(name);
  });
  return fuzzy ?? null;
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
