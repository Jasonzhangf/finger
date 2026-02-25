export interface AgentToolPolicy {
  agentId: string;
  whitelist: string[];
  blacklist: string[];
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

function normalizeToolNames(toolNames: string[]): string[] {
  return Array.from(
    new Set(
      toolNames
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  );
}

export class AgentToolAccessControl {
  private readonly whitelist = new Map<string, Set<string>>();
  private readonly blacklist = new Map<string, Set<string>>();

  setWhitelist(agentId: string, toolNames: string[]): AgentToolPolicy {
    this.whitelist.set(agentId, new Set(normalizeToolNames(toolNames)));
    return this.getPolicy(agentId);
  }

  setBlacklist(agentId: string, toolNames: string[]): AgentToolPolicy {
    this.blacklist.set(agentId, new Set(normalizeToolNames(toolNames)));
    return this.getPolicy(agentId);
  }

  grant(agentId: string, toolName: string): AgentToolPolicy {
    const normalized = toolName.trim();
    if (normalized.length === 0) {
      return this.getPolicy(agentId);
    }

    const current = this.whitelist.get(agentId) ?? new Set<string>();
    current.add(normalized);
    this.whitelist.set(agentId, current);
    return this.getPolicy(agentId);
  }

  revoke(agentId: string, toolName: string): AgentToolPolicy {
    const current = this.whitelist.get(agentId);
    if (!current) return this.getPolicy(agentId);

    current.delete(toolName.trim());
    this.whitelist.set(agentId, current);
    return this.getPolicy(agentId);
  }

  deny(agentId: string, toolName: string): AgentToolPolicy {
    const normalized = toolName.trim();
    if (normalized.length === 0) {
      return this.getPolicy(agentId);
    }

    const current = this.blacklist.get(agentId) ?? new Set<string>();
    current.add(normalized);
    this.blacklist.set(agentId, current);
    return this.getPolicy(agentId);
  }

  allow(agentId: string, toolName: string): AgentToolPolicy {
    const current = this.blacklist.get(agentId);
    if (!current) return this.getPolicy(agentId);

    current.delete(toolName.trim());
    this.blacklist.set(agentId, current);
    return this.getPolicy(agentId);
  }

  clear(agentId: string): void {
    this.whitelist.delete(agentId);
    this.blacklist.delete(agentId);
  }

  getPolicy(agentId: string): AgentToolPolicy {
    const whitelist = Array.from(this.whitelist.get(agentId) ?? []).sort();
    const blacklist = Array.from(this.blacklist.get(agentId) ?? []).sort();
    return {
      agentId,
      whitelist,
      blacklist,
    };
  }

  canUse(agentId: string, toolName: string): AccessDecision {
    const normalized = toolName.trim();
    const denySet = this.blacklist.get(agentId);
    if (denySet?.has(normalized)) {
      return {
        allowed: false,
        reason: `tool '${normalized}' is blacklisted for agent '${agentId}'`,
      };
    }

    const allowSet = this.whitelist.get(agentId);
    if (!allowSet || allowSet.size === 0) {
      return {
        allowed: false,
        reason: `tool '${normalized}' is not granted for agent '${agentId}'`,
      };
    }

    if (!allowSet.has(normalized)) {
      return {
        allowed: false,
        reason: `tool '${normalized}' is not in whitelist for agent '${agentId}'`,
      };
    }

    return { allowed: true, reason: 'allowed by whitelist' };
  }
}
