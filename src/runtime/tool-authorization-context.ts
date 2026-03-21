export type AuthorizationMode = 'prompt' | 'auto' | 'deny';

interface AgentAuthorizationContext {
  mode: AuthorizationMode;
  channelId?: string;
  updatedAt: number;
}

const agentAuthorization = new Map<string, AgentAuthorizationContext>();

export function setAgentAuthorizationMode(
  agentId: string,
  mode: AuthorizationMode,
  channelId?: string,
): void {
  const normalized = agentId.trim();
  if (!normalized) return;
  agentAuthorization.set(normalized, {
    mode,
    channelId,
    updatedAt: Date.now(),
  });
}

export function getAgentAuthorizationMode(agentId: string): AuthorizationMode | undefined {
  const normalized = agentId.trim();
  if (!normalized) return undefined;
  return agentAuthorization.get(normalized)?.mode;
}

export function getAgentAuthorizationContext(agentId: string): AgentAuthorizationContext | undefined {
  const normalized = agentId.trim();
  if (!normalized) return undefined;
  return agentAuthorization.get(normalized);
}

export function clearAgentAuthorizationMode(agentId: string): void {
  const normalized = agentId.trim();
  if (!normalized) return;
  agentAuthorization.delete(normalized);
}
