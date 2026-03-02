import type { AgentRuntimeBlock } from '../../../blocks/agent-runtime-block/index.js';
import type { SessionManager } from '../../../orchestration/session-manager.js';
import type { AskManager } from '../../../orchestration/ask/ask-manager.js';
import type { UnifiedEventBus } from '../../../runtime/event-bus.js';
import type { runtimeInstructionBus as RuntimeInstructionBusType } from '../../../orchestration/runtime-instruction-bus.js';
import type { BdTools } from '../../../agents/shared/bd-tools.js';
import type { RuntimeFacade } from '../../../runtime/runtime-facade.js';
import type { SessionWorkspaceManager } from '../session-workspaces.js';
import type { AgentRuntimeDeps } from './types.js';

export interface AgentRuntimeDepsBase {
  runtime: RuntimeFacade;
  sessionManager: SessionManager;
  sessionWorkspaces: SessionWorkspaceManager;
  askManager: AskManager;
  eventBus: UnifiedEventBus;
  runtimeInstructionBus: typeof RuntimeInstructionBusType;
  bdTools: BdTools;
  broadcast: (message: Record<string, unknown>) => void;
  primaryOrchestratorAgentId: string;
  isPrimaryOrchestratorTarget: (target: string) => boolean;
}

export function createGetAgentRuntimeDeps(
  getAgentRuntimeBlock: () => AgentRuntimeBlock,
  base: AgentRuntimeDepsBase,
): () => AgentRuntimeDeps {
  const {
    runtime,
    sessionManager,
    sessionWorkspaces,
    askManager,
    eventBus,
    runtimeInstructionBus,
    bdTools,
    broadcast,
    primaryOrchestratorAgentId,
    isPrimaryOrchestratorTarget,
  } = base;

  return (): AgentRuntimeDeps => ({
    agentRuntimeBlock: getAgentRuntimeBlock(),
    runtime,
    sessionManager,
    sessionWorkspaces,
    askManager,
    eventBus,
    runtimeInstructionBus,
    bdTools,
    broadcast,
    primaryOrchestratorAgentId,
    isPrimaryOrchestratorTarget,
    ensureOrchestratorRootSession: () => sessionWorkspaces.ensureOrchestratorRootSession(),
    ensureRuntimeChildSession: (root, agentId) => sessionWorkspaces.ensureRuntimeChildSession(root, agentId),
    isRuntimeChildSession: (session) => sessionWorkspaces.isRuntimeChildSession(session),
  });
}
