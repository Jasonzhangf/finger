import { randomUUID } from 'crypto';

export interface ToolAuthorizationGrant {
  token: string;
  agentId: string;
  toolName: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: number;
  remainingUses: number;
}

interface ToolAuthorizationState extends ToolAuthorizationGrant {}

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export interface AuthorizationIssueOptions {
  ttlMs?: number;
  maxUses?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_USES = 1;

export class ToolAuthorizationManager {
  private readonly requiredTools = new Set<string>();
  private readonly grants = new Map<string, ToolAuthorizationState>();

  setToolRequired(toolName: string, required: boolean): void {
    if (required) {
      this.requiredTools.add(toolName);
      return;
    }
    this.requiredTools.delete(toolName);
  }

  isToolRequired(toolName: string): boolean {
    return this.requiredTools.has(toolName);
  }

  issue(
    agentId: string,
    toolName: string,
    issuedBy: string,
    options: AuthorizationIssueOptions = {},
  ): ToolAuthorizationGrant {
    const ttlMs =
      typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs) && options.ttlMs > 0
        ? Math.floor(options.ttlMs)
        : DEFAULT_TTL_MS;
    const maxUses =
      typeof options.maxUses === 'number' && Number.isFinite(options.maxUses) && options.maxUses > 0
        ? Math.floor(options.maxUses)
        : DEFAULT_MAX_USES;

    const now = Date.now();
    const grant: ToolAuthorizationState = {
      token: randomUUID(),
      agentId,
      toolName,
      issuedBy,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      maxUses,
      remainingUses: maxUses,
    };
    this.grants.set(grant.token, grant);
    return { ...grant };
  }

  revoke(token: string): boolean {
    return this.grants.delete(token);
  }

  verifyAndConsume(token: string | undefined, agentId: string, toolName: string): AuthorizationDecision {
    if (!token || token.trim().length === 0) {
      return {
        allowed: false,
        reason: `authorization token required for tool '${toolName}'`,
      };
    }

    const grant = this.grants.get(token);
    if (!grant) {
      return {
        allowed: false,
        reason: `authorization token not found for tool '${toolName}'`,
      };
    }

    if (grant.agentId !== agentId || grant.toolName !== toolName) {
      return {
        allowed: false,
        reason: `authorization token scope mismatch for agent '${agentId}' and tool '${toolName}'`,
      };
    }

    const now = Date.now();
    if (now > Date.parse(grant.expiresAt)) {
      this.grants.delete(token);
      return {
        allowed: false,
        reason: `authorization token expired for tool '${toolName}'`,
      };
    }

    if (grant.remainingUses <= 0) {
      this.grants.delete(token);
      return {
        allowed: false,
        reason: `authorization token exhausted for tool '${toolName}'`,
      };
    }

    grant.remainingUses -= 1;
    if (grant.remainingUses <= 0) {
      this.grants.delete(token);
    } else {
      this.grants.set(token, grant);
    }

    return { allowed: true, reason: 'authorized' };
  }
}
