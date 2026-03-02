import type { AgentRuntimeBlock } from '../../blocks/agent-runtime-block/index.js';
import type { OrchestrationConfigV1 } from '../../orchestration/orchestration-config.js';
import { normalizeReviewPolicy } from '../../orchestration/orchestration-config.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { setActiveReviewPolicy } from '../orchestration/review-policy.js';
import type { SessionWorkspaceManager } from './session-workspaces.js';

export interface OrchestrationConfigApplierDeps {
  agentRuntimeBlock: AgentRuntimeBlock;
  sessionManager: SessionManager;
  sessionWorkspaces: SessionWorkspaceManager;
}

export function createOrchestrationConfigApplier(deps: OrchestrationConfigApplierDeps) {
  const { agentRuntimeBlock, sessionManager, sessionWorkspaces } = deps;

  return async function applyOrchestrationConfig(config: OrchestrationConfigV1): Promise<{
    applied: number;
    agents: string[];
    profileId: string;
  }> {
    const profile = config.profiles.find((item) => item.id === config.activeProfileId);
    if (!profile) {
      throw new Error(`active orchestration profile not found: ${config.activeProfileId}`);
    }
    setActiveReviewPolicy(normalizeReviewPolicy(profile.reviewPolicy));
    const rootSession = sessionWorkspaces.ensureOrchestratorRootSession();
    const appliedAgents: string[] = [];
    const activeAgentIds = new Set(
      profile.agents.filter((item) => item.enabled !== false).map((item) => item.targetAgentId),
    );
    const runtimeView = await agentRuntimeBlock.execute('runtime_view', {}) as {
      agents?: Array<{ id: string; instanceCount?: number }>;
    };
    const currentlyStartedAgentIds = (runtimeView.agents ?? [])
      .filter((item) => (Number.isFinite(item.instanceCount) ? (item.instanceCount as number) > 0 : false))
      .map((item) => item.id);

    for (const staleAgentId of currentlyStartedAgentIds) {
      if (activeAgentIds.has(staleAgentId)) continue;
      const staleSession = sessionWorkspaces.findRuntimeChildSession(rootSession.id, staleAgentId);
      await agentRuntimeBlock.execute('deploy', {
        sessionId: staleSession?.id ?? rootSession.id,
        scope: 'session',
        targetAgentId: staleAgentId,
        config: {
          id: staleAgentId,
          name: staleAgentId,
          enabled: false,
        },
      });
    }

    for (const entry of profile.agents) {
      if (entry.enabled === false) continue;
      const targetSessionId = entry.role === 'orchestrator'
        ? rootSession.id
        : sessionWorkspaces.ensureRuntimeChildSession(rootSession, entry.targetAgentId).id;
      await agentRuntimeBlock.execute('deploy', {
        sessionId: targetSessionId,
        scope: 'session',
        targetAgentId: entry.targetAgentId,
        ...(typeof entry.targetImplementationId === 'string'
          ? { targetImplementationId: entry.targetImplementationId }
          : {}),
        instanceCount: entry.instanceCount ?? 1,
        launchMode: entry.launchMode ?? (entry.role === 'orchestrator' ? 'orchestrator' : 'manual'),
        config: {
          id: entry.targetAgentId,
          name: entry.targetAgentId,
          role: entry.role,
          enabled: true,
        },
      });
      appliedAgents.push(entry.targetAgentId);
    }
    sessionManager.setCurrentSession(rootSession.id);
    return {
      applied: appliedAgents.length,
      agents: appliedAgents,
      profileId: profile.id,
    };
  };
}
