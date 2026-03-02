import type { SessionManager } from '../../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../../runtime/event-bus.js';
import type {
  ChatCodexRunner,
  ChatCodexRunnerInterruptResult,
  ChatCodexRunnerSessionState,
} from '../../../agents/finger-general/finger-general-module.js';

export type MockAgentRole = 'executor' | 'reviewer' | 'searcher';
export type MockOutcome = 'success' | 'failure';

export interface MockDispatchAssertion {
  id: string;
  timestamp: string;
  agentId: string;
  agentRole: MockAgentRole;
  sessionId?: string;
  workflowId?: string;
  taskId?: string;
  content: string;
  payload: unknown;
  result: {
    ok: boolean;
    summary: string;
  };
}

export type DispatchTaskLike = (input: {
  sourceAgentId: string;
  targetAgentId: string;
  task: unknown;
  sessionId?: string;
  workflowId?: string;
  blocking?: boolean;
  queueOnBusy?: boolean;
  metadata?: Record<string, unknown>;
}) => Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  queuePosition?: number;
}>;

export type ChatCodexRunnerController = ChatCodexRunner & {
  listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[];
  interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[];
};

export interface MockRuntimeDeps {
  dispatchTask: DispatchTaskLike;
  eventBus: UnifiedEventBus;
  sessionManager: SessionManager;
  getBroadcast?: () => ((message: Record<string, unknown>) => void) | undefined;
  primaryOrchestratorAgentId: string;
  agentIds: {
    researcher: string;
    executor: string;
    reviewer: string;
  };
  maxAssertions?: number;
}
