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
  sessionStrategy?: 'current' | 'latest' | 'new';
  projectPath?: string;
  workflowId?: string;
  blocking?: boolean;
  queueOnBusy?: boolean;
  maxQueueWaitMs?: number;
  assignment?: {
    epicId?: string;
    taskId?: string;
    taskName?: string;
    /** Required blocker declaration for task generation. Use ['none'] when not blocked. */
    blockedBy?: string[];
    bdTaskId?: string;
    assignerAgentId?: string;
    assignerName?: string;
    assigneeAgentId?: string;
    assigneeName?: string;
    phase?: 'assigned' | 'queued' | 'started' | 'reviewing' | 'retry' | 'passed' | 'failed' | 'closed';
    attempt?: number;
    /** 交付验收标准，project agent 完成后按此标准 review */
    acceptanceCriteria?: string;
    /** 是否需要 review agent 审查交付结果 */
    reviewRequired?: boolean;
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
  blockingReason?: string;
  decisionImpact?: 'critical' | 'major' | 'normal';
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  epicId?: string;
  channelId?: string;
  userId?: string;
  groupId?: string;
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
  dispatchTaskToAgent?: (deps: AgentRuntimeDeps, input: AgentDispatchRequest) => Promise<{dispatchId: string; status: string; error?: string}>;
}
