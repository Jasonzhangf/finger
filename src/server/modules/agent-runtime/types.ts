import type { AgentRuntimeBlock } from '../../../blocks/agent-runtime-block/index.js';
import type { RuntimeFacade } from '../../../runtime/runtime-facade.js';
import type { SessionManager } from '../../../orchestration/session-manager.js';
import type { AskManager } from '../../../orchestration/ask/ask-manager.js';
import type { UnifiedEventBus } from '../../../runtime/event-bus.js';
import type { runtimeInstructionBus as RuntimeInstructionBusType } from '../../../orchestration/runtime-instruction-bus.js';
type RuntimeInstructionBus = typeof RuntimeInstructionBusType;
import type { BdTools } from '../../../agents/shared/bd-tools.js';
import type { RootSessionInfo, SessionWorkspaceManager } from '../session-workspaces.js';

export type AgentCapabilityLayer = 'summary' | 'execution' | 'governance' | 'full';

export interface AgentDispatchRequest {
  sourceAgentId: string;
  targetAgentId: string;
  task: unknown;
  sessionId?: string;
  workflowId?: string;
  blocking?: boolean;
  queueOnBusy?: boolean;
  maxQueueWaitMs?: number;
  assignment?: {
    epicId?: string;
    taskId?: string;
    bdTaskId?: string;
    assignerAgentId?: string;
    assigneeAgentId?: string;
    phase?: 'assigned' | 'queued' | 'started' | 'reviewing' | 'retry' | 'passed' | 'failed' | 'closed';
    attempt?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface AgentControlRequest {
  action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel' | 'dispatch';
  targetAgentId?: string;
  sessionId?: string;
  workflowId?: string;
  providerId?: string;
  hard?: boolean;
  task?: unknown;
  blocking?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentControlResult {
  ok: boolean;
  action: AgentControlRequest['action'];
  status: 'accepted' | 'completed' | 'failed';
  sessionId?: string;
  workflowId?: string;
  targetAgentId?: string;
  result?: unknown;
  error?: string;
}

export interface AskToolRequest {
  question: string;
  options?: string[];
  context?: string;
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  epicId?: string;
  timeoutMs?: number;
}

export interface AgentRuntimeDeps {
  agentRuntimeBlock: AgentRuntimeBlock;
  runtime: RuntimeFacade;
  sessionManager: SessionManager;
  sessionWorkspaces: SessionWorkspaceManager;
  askManager: AskManager;
  eventBus: UnifiedEventBus;
  runtimeInstructionBus: RuntimeInstructionBus;
  bdTools: BdTools;
  broadcast: (message: Record<string, unknown>) => void;
  primaryOrchestratorAgentId: string;
  isPrimaryOrchestratorTarget: (target: string) => boolean;
  ensureOrchestratorRootSession: () => RootSessionInfo;
  ensureRuntimeChildSession: (root: RootSessionInfo, agentId: string) => { id: string; projectPath: string };
  isRuntimeChildSession: (session: { context?: Record<string, unknown> } | null | undefined) => boolean;
}
