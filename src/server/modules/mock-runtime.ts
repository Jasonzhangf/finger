import type { ModuleRegistry, OutputModule } from '../../orchestration/module-registry.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type {
  ChatCodexKernelEvent,
  ChatCodexRunContext,
  ChatCodexRunResult,
  ChatCodexRunner,
  ChatCodexRunnerInterruptResult,
  ChatCodexRunnerSessionState,
  KernelInputItem,
} from '../../agents/finger-general/finger-general-module.js';
import { isObjectRecord } from '../common/object.js';
import { asString, firstNonEmptyString } from '../common/strings.js';

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

export interface MockRuntimeKit {
  mockRolePolicy: Record<MockAgentRole, MockOutcome>;
  debugRuntimeModuleIds: readonly string[];
  createMockChatCodexRunner(): ChatCodexRunnerController;
  createAdaptiveChatCodexRunner(
    realRunner: ChatCodexRunnerController,
    mockRunner: ChatCodexRunnerController,
    shouldUseMock: () => boolean,
  ): ChatCodexRunnerController;
  createMockRuntimeRoleModule(params: { id: string; name: string; role: MockAgentRole }): OutputModule;
  ensureDebugRuntimeModules(enabled: boolean, moduleRegistry: ModuleRegistry): Promise<void>;
  clearMockDispatchAssertions(): void;
  listMockDispatchAssertions(filters: {
    agentId?: string;
    workflowId?: string;
    sessionId?: string;
    limit?: number;
  }): MockDispatchAssertion[];
}

function parseMockOutcome(raw: string | undefined): MockOutcome {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'failure' || normalized === 'fail' || normalized === 'error'
    ? 'failure'
    : 'success';
}

function pickMessageContext(
  message: unknown,
): {
  sessionId?: string;
  workflowId?: string;
  taskId?: string;
  content: string;
  assignment?: Record<string, unknown>;
} {
  const record = isObjectRecord(message) ? message : {};
  const metadata = isObjectRecord(record.metadata) ? record.metadata : {};
  const assignment = isObjectRecord(metadata.assignment) ? metadata.assignment : undefined;
  const sessionId = firstNonEmptyString(record.sessionId, record.session_id, metadata.sessionId, metadata.session_id);
  const workflowId = firstNonEmptyString(record.workflowId, record.workflow_id, metadata.workflowId, metadata.workflow_id);
  const taskId = firstNonEmptyString(
    record.taskId,
    record.task_id,
    metadata.taskId,
    metadata.task_id,
    assignment?.taskId,
    assignment?.task_id,
  );
  const content = firstNonEmptyString(record.description, record.text, record.content, taskId) ?? '[empty task]';
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(taskId ? { taskId } : {}),
    content,
    ...(assignment ? { assignment } : {}),
  };
}

const DEFAULT_DEBUG_RUNTIME_MODULE_IDS = ['executor-debug-agent', 'reviewer-debug-agent', 'searcher-debug-agent'] as const;

export function createMockRuntimeKit(deps: MockRuntimeDeps): MockRuntimeKit {
  const {
    dispatchTask,
    eventBus,
    sessionManager,
    getBroadcast,
    primaryOrchestratorAgentId,
    agentIds,
    maxAssertions = 400,
  } = deps;

  const mockDispatchAssertions: MockDispatchAssertion[] = [];
  const mockRolePolicy: Record<MockAgentRole, MockOutcome> = {
    executor: parseMockOutcome(process.env.FINGER_MOCK_EXECUTOR_OUTCOME),
    reviewer: parseMockOutcome(process.env.FINGER_MOCK_REVIEWER_OUTCOME),
    searcher: parseMockOutcome(process.env.FINGER_MOCK_SEARCHER_OUTCOME),
  };

  const recordMockDispatchAssertion = (input: {
    agentId: string;
    agentRole: MockAgentRole;
    message: unknown;
    result: { ok: boolean; summary: string };
  }): MockDispatchAssertion => {
    const timestamp = new Date().toISOString();
    const context = pickMessageContext(input.message);
    const assertion: MockDispatchAssertion = {
      id: `assert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      agentId: input.agentId,
      agentRole: input.agentRole,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      ...(context.taskId ? { taskId: context.taskId } : {}),
      content: context.content,
      payload: input.message,
      result: input.result,
    };

    mockDispatchAssertions.push(assertion);
    while (mockDispatchAssertions.length > maxAssertions) {
      mockDispatchAssertions.shift();
    }

    const broadcast = getBroadcast?.();
    if (broadcast) {
      broadcast({
        type: 'agent_runtime_mock_assertion',
        sessionId: assertion.sessionId ?? 'default',
        agentId: assertion.agentId,
        timestamp,
        payload: assertion,
      });
    }

    return assertion;
  };

  class MockChatCodexRunner implements ChatCodexRunnerController {
    private readonly sessions = new Map<string, { sessionId: string; providerId: string }>();

    async runTurn(text: string, _items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
      const sessionId = typeof context?.sessionId === 'string' && context.sessionId.trim().length > 0
        ? context.sessionId.trim()
        : 'mock-session';
      const metadata = isObjectRecord(context?.metadata) ? context.metadata : {};
      const roleProfile = firstNonEmptyString(
        metadata.roleProfile,
        metadata.role_profile,
        metadata.contextLedgerRole,
        metadata.context_ledger_role,
        metadata.role,
      ) ?? 'orchestrator';
      const workflowId = firstNonEmptyString(metadata.workflowId, metadata.workflow_id) ?? `wf-mock-${Date.now()}`;
      const content = text.trim().length > 0 ? text.trim() : '[empty input]';
      const turnId = `mock-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      this.sessions.set(sessionId, { sessionId, providerId: 'mock' });

      const normalizedRole = roleProfile.trim().toLowerCase();
      if (!normalizedRole.includes('orchestr') && normalizedRole !== 'general') {
        return this.runRoleTurn(normalizedRole, {
          sessionId,
          workflowId,
          content,
          turnId,
          historyCount: Array.isArray(context?.history) ? context.history.length : 0,
        });
      }

      const searchTask = {
        description: `research: ${content}`,
        content,
        text: content,
        sessionId,
        workflowId,
        taskId: `task-research-${Date.now()}`,
        metadata: {
          role: 'searcher',
          source: 'finger-general-mock-runner',
        },
      };
      const searchDispatch = await this.dispatch(agentIds.researcher, searchTask, sessionId, workflowId, 'searcher');

      const executorTask = {
        description: `execute: ${content}`,
        content,
        text: content,
        sessionId,
        workflowId,
        taskId: `task-executor-${Date.now()}`,
        metadata: {
          role: 'executor',
          source: 'finger-general-mock-runner',
          research: searchDispatch.result,
        },
      };
      const executorDispatch = await this.dispatch(agentIds.executor, executorTask, sessionId, workflowId, 'executor');

      const reviewerTask = {
        description: `review: ${content}`,
        content,
        text: content,
        sessionId,
        workflowId,
        taskId: `task-review-${Date.now()}`,
        metadata: {
          role: 'reviewer',
          source: 'finger-general-mock-runner',
          claims: executorDispatch.result,
          evidence: executorDispatch.result,
        },
      };
      const reviewerDispatch = await this.dispatch(agentIds.reviewer, reviewerTask, sessionId, workflowId, 'reviewer');

      const reviewerResult = isObjectRecord(reviewerDispatch.result) ? reviewerDispatch.result : {};
      const reviewerPassed = reviewerResult.passed === true || reviewerResult.reviewDecision === 'pass';
      const reply = reviewerPassed
        ? `[mock runner] 执行完成: ${content}`
        : `[mock runner] 需要重试: ${content}`;

      const kernelMetadata: Record<string, unknown> = {
        stop_reason: reviewerPassed ? 'mock_pass' : 'mock_retry',
        pendingInputAccepted: false,
        tool_trace: [
          {
            seq: 1,
            call_id: searchDispatch.dispatchId,
            tool: `agent.dispatch.${agentIds.researcher}`,
            status: searchDispatch.ok ? 'ok' : 'error',
            input: searchTask,
            ...(searchDispatch.ok ? { output: searchDispatch.result } : { error: searchDispatch.error ?? 'dispatch failed' }),
          },
          {
            seq: 2,
            call_id: executorDispatch.dispatchId,
            tool: `agent.dispatch.${agentIds.executor}`,
            status: executorDispatch.ok ? 'ok' : 'error',
            input: executorTask,
            ...(executorDispatch.ok ? { output: executorDispatch.result } : { error: executorDispatch.error ?? 'dispatch failed' }),
          },
          {
            seq: 3,
            call_id: reviewerDispatch.dispatchId,
            tool: `agent.dispatch.${agentIds.reviewer}`,
            status: reviewerDispatch.ok ? 'ok' : 'error',
            input: reviewerTask,
            ...(reviewerDispatch.ok ? { output: reviewerDispatch.result } : { error: reviewerDispatch.error ?? 'dispatch failed' }),
          },
        ],
        round_trace: [
          {
            seq: 1,
            round: 1,
            function_calls_count: 3,
            reasoning_count: 1,
            history_items_count: Array.isArray(context?.history) ? context.history.length : 0,
            has_output_text: true,
            finish_reason: reviewerPassed ? 'completed' : 'review_retry',
            response_status: reviewerPassed ? 'success' : 'retry',
          },
        ],
        dispatches: {
          searcher: searchDispatch,
          executor: executorDispatch,
          reviewer: reviewerDispatch,
        },
      };

      const events: ChatCodexKernelEvent[] = [
        {
          id: turnId,
          msg: {
            type: 'task_started',
            message: 'mock runner started',
            model_context_window: 128000,
          },
        },
        {
          id: turnId,
          msg: {
            type: 'model_round',
            round: 1,
            function_calls_count: 3,
            reasoning_count: 1,
            has_output_text: true,
            finish_reason: reviewerPassed ? 'completed' : 'review_retry',
            response_status: reviewerPassed ? 'success' : 'retry',
          },
        },
        {
          id: turnId,
          msg: {
            type: 'task_complete',
            last_agent_message: reply,
            metadata_json: JSON.stringify(kernelMetadata),
          },
        },
      ];

      return {
        reply,
        events,
        usedBinaryPath: 'mock://finger-general-runner',
        kernelMetadata,
      };
    }

    private async runRoleTurn(
      roleProfile: string,
      input: {
        sessionId: string;
        workflowId: string;
        content: string;
        turnId: string;
        historyCount: number;
      },
    ): Promise<ChatCodexRunResult> {
      if (roleProfile.includes('review')) {
        const reply = `[mock reviewer] reviewed: ${input.content}`;
        return {
          reply,
          events: [
            {
              id: input.turnId,
              msg: {
                type: 'task_complete',
                last_agent_message: reply,
                metadata_json: JSON.stringify({
                  stop_reason: 'mock_reviewer_pass',
                  pendingInputAccepted: false,
                  round_trace: [{
                    seq: 1,
                    round: 1,
                    function_calls_count: 0,
                    reasoning_count: 1,
                    history_items_count: input.historyCount,
                    has_output_text: true,
                    finish_reason: 'completed',
                    response_status: 'success',
                  }],
                }),
              },
            },
          ],
          usedBinaryPath: 'mock://finger-general-runner',
        };
      }

      if (roleProfile.includes('search') || roleProfile.includes('research')) {
        const reply = `[mock researcher] summary for: ${input.content}`;
        return {
          reply,
          events: [
            {
              id: input.turnId,
              msg: {
                type: 'task_complete',
                last_agent_message: reply,
                metadata_json: JSON.stringify({
                  stop_reason: 'mock_search_done',
                  pendingInputAccepted: false,
                  round_trace: [{
                    seq: 1,
                    round: 1,
                    function_calls_count: 0,
                    reasoning_count: 1,
                    history_items_count: input.historyCount,
                    has_output_text: true,
                    finish_reason: 'completed',
                    response_status: 'success',
                  }],
                }),
              },
            },
          ],
          usedBinaryPath: 'mock://finger-general-runner',
        };
      }

      const reply = `[mock executor] completed: ${input.content}`;
      return {
        reply,
        events: [
          {
            id: input.turnId,
            msg: {
              type: 'task_complete',
              last_agent_message: reply,
              metadata_json: JSON.stringify({
                stop_reason: 'mock_executor_done',
                pendingInputAccepted: false,
                round_trace: [{
                  seq: 1,
                  round: 1,
                  function_calls_count: 0,
                  reasoning_count: 1,
                  history_items_count: input.historyCount,
                  has_output_text: true,
                  finish_reason: 'completed',
                  response_status: 'success',
                }],
              }),
            },
          },
        ],
        usedBinaryPath: 'mock://finger-general-runner',
      };
    }

    listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
      const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
      const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
      const states: ChatCodexRunnerSessionState[] = [];
      for (const session of this.sessions.values()) {
        if (normalizedSessionId.length > 0 && session.sessionId !== normalizedSessionId) continue;
        if (normalizedProviderId.length > 0 && session.providerId !== normalizedProviderId) continue;
        states.push({
          sessionKey: `${session.sessionId}::provider=${session.providerId}`,
          sessionId: session.sessionId,
          providerId: session.providerId,
          hasActiveTurn: false,
        });
      }
      return states;
    }

    interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[] {
      const normalizedSessionId = sessionId.trim();
      if (normalizedSessionId.length === 0) return [];
      const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
      const session = this.sessions.get(normalizedSessionId);
      if (!session) return [];
      if (normalizedProviderId.length > 0 && session.providerId !== normalizedProviderId) return [];
      this.sessions.delete(normalizedSessionId);
      return [{
        sessionKey: `${session.sessionId}::provider=${session.providerId}`,
        sessionId: session.sessionId,
        providerId: session.providerId,
        hadActiveTurn: false,
        interrupted: false,
      }];
    }

    private async dispatch(
      targetAgentId: string,
      task: Record<string, unknown>,
      sessionId: string,
      workflowId: string,
      role: MockAgentRole,
    ): Promise<Awaited<ReturnType<DispatchTaskLike>>> {
      try {
        return await dispatchTask({
          sourceAgentId: primaryOrchestratorAgentId,
          targetAgentId,
          task,
          sessionId,
          workflowId,
          blocking: true,
          queueOnBusy: true,
          metadata: {
            role,
            source: 'finger-general-mock-runner',
          },
        });
      } catch (error) {
        return {
          ok: false,
          dispatchId: `dispatch-${targetAgentId}-${Date.now()}-error`,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  class AdaptiveChatCodexRunner implements ChatCodexRunnerController {
    private readonly realRunner: ChatCodexRunnerController;
    private readonly mockRunner: ChatCodexRunnerController;
    private readonly shouldUseMock: () => boolean;

    constructor(realRunner: ChatCodexRunnerController, mockRunner: ChatCodexRunnerController, shouldUseMock: () => boolean) {
      this.realRunner = realRunner;
      this.mockRunner = mockRunner;
      this.shouldUseMock = shouldUseMock;
    }

    runTurn(text: string, items?: KernelInputItem[], context?: ChatCodexRunContext): Promise<ChatCodexRunResult> {
      return (this.shouldUseMock() ? this.mockRunner : this.realRunner).runTurn(text, items, context);
    }

    listSessionStates(sessionId?: string, providerId?: string): ChatCodexRunnerSessionState[] {
      return (this.shouldUseMock() ? this.mockRunner : this.realRunner).listSessionStates(sessionId, providerId);
    }

    interruptSession(sessionId: string, providerId?: string): ChatCodexRunnerInterruptResult[] {
      return (this.shouldUseMock() ? this.mockRunner : this.realRunner).interruptSession(sessionId, providerId);
    }
  }

  const createMockRuntimeRoleModule = (params: { id: string; name: string; role: MockAgentRole }): OutputModule => ({
    id: params.id,
    type: 'output',
    name: params.name,
    version: '1.0.0',
    metadata: {
      role: params.role,
      type: `${params.role}-agent`,
      mode: 'mock',
      provider: 'mock',
    },
    handle: async (message: unknown, callback?: (result: unknown) => void) => {
      const taskPayload = isObjectRecord(message) && message.task !== undefined ? message.task : message;
      const context = pickMessageContext(taskPayload);
      const timestamp = new Date().toISOString();
      const outcome = mockRolePolicy[params.role];
      const ok = outcome === 'success';
      const runStatus = ok ? 'ok' : 'error';

      void eventBus.emit({
        type: 'agent_runtime_status',
        sessionId: context.sessionId ?? 'default',
        agentId: params.id,
        timestamp,
        payload: {
          scope: context.workflowId ? 'workflow' : 'session',
          status: runStatus,
          ...(context.workflowId ? { workflowId: context.workflowId } : {}),
          runningAgents: [params.id],
        },
      });

      let result: Record<string, unknown>;
      if (params.role === 'reviewer') {
        result = ok
          ? {
              success: true,
              reviewDecision: 'pass',
              passed: true,
              summary: `[mock:reviewer] approved ${context.taskId ?? context.content}`,
            }
          : {
              success: true,
              reviewDecision: 'retry',
              passed: false,
              comments: `[mock:reviewer] forced retry for ${context.taskId ?? context.content}`,
              summary: `[mock:reviewer] retry ${context.taskId ?? context.content}`,
            };
      } else if (params.role === 'searcher') {
        result = ok
          ? {
              success: true,
              taskId: context.taskId,
              summary: `[mock:searcher] summary for ${context.taskId ?? context.content}`,
              artifacts: {
                summaryPath: `mock://${params.id}/summary.md`,
                memoryPath: `mock://${params.id}/memory.jsonl`,
              },
            }
          : {
              success: false,
              taskId: context.taskId,
              error: `[mock:searcher] forced failure for ${context.taskId ?? context.content}`,
            };
      } else {
        result = ok
          ? {
              success: true,
              taskId: context.taskId,
              output: `[mock:executor] completed ${context.content}`,
            }
          : {
              success: false,
              taskId: context.taskId,
              error: `[mock:executor] forced failure for ${context.content}`,
            };
      }
      const summary = ok
        ? `[mock:${params.role}] success ${context.taskId ?? context.content}`
        : `[mock:${params.role}] failure ${context.taskId ?? context.content}`;
      recordMockDispatchAssertion({
        agentId: params.id,
        agentRole: params.role,
        message: taskPayload,
        result: { ok, summary },
      });

      void eventBus.emit({
        type: 'agent_runtime_status',
        sessionId: context.sessionId ?? 'default',
        agentId: params.id,
        timestamp: new Date().toISOString(),
        payload: {
          scope: context.workflowId ? 'workflow' : 'session',
          status: runStatus,
          ...(context.workflowId ? { workflowId: context.workflowId } : {}),
          runningAgents: [],
        },
      });

      if (callback) callback(result);
      return result;
    },
  });

  const ensureDebugRuntimeModules = async (enabled: boolean, moduleRegistry: ModuleRegistry): Promise<void> => {
    const executorId = DEFAULT_DEBUG_RUNTIME_MODULE_IDS[0];
    const reviewerId = DEFAULT_DEBUG_RUNTIME_MODULE_IDS[1];
    const searcherId = DEFAULT_DEBUG_RUNTIME_MODULE_IDS[2];
    if (enabled) {
      if (!moduleRegistry.getModule(executorId)) {
        await moduleRegistry.register(createMockRuntimeRoleModule({
          id: executorId,
          name: 'Executor Debug Agent',
          role: 'executor',
        }));
      }
      if (!moduleRegistry.getModule(reviewerId)) {
        await moduleRegistry.register(createMockRuntimeRoleModule({
          id: reviewerId,
          name: 'Reviewer Debug Agent',
          role: 'reviewer',
        }));
      }
      if (!moduleRegistry.getModule(searcherId)) {
        await moduleRegistry.register(createMockRuntimeRoleModule({
          id: searcherId,
          name: 'Searcher Debug Agent',
          role: 'searcher',
        }));
      }
      return;
    }

    for (const moduleId of DEFAULT_DEBUG_RUNTIME_MODULE_IDS) {
      if (!moduleRegistry.getModule(moduleId)) continue;
      await moduleRegistry.unregister(moduleId);
    }
  };

  const createMockChatCodexRunner = (): ChatCodexRunnerController => new MockChatCodexRunner();
  const createAdaptiveChatCodexRunner = (
    realRunner: ChatCodexRunnerController,
    mockRunner: ChatCodexRunnerController,
    shouldUseMock: () => boolean,
  ): ChatCodexRunnerController => new AdaptiveChatCodexRunner(realRunner, mockRunner, shouldUseMock);

  const clearMockDispatchAssertions = (): void => {
    mockDispatchAssertions.splice(0, mockDispatchAssertions.length);
  };

  const listMockDispatchAssertions = (filters: {
    agentId?: string;
    workflowId?: string;
    sessionId?: string;
    limit?: number;
  }): MockDispatchAssertion[] => {
    const agentId = asString(filters.agentId) ?? '';
    const workflowId = asString(filters.workflowId) ?? '';
    const sessionId = asString(filters.sessionId) ?? '';
    const limit = typeof filters.limit === 'number' && Number.isFinite(filters.limit)
      ? Math.max(1, Math.min(200, Math.floor(filters.limit)))
      : 100;
    return mockDispatchAssertions
      .filter((item) => (agentId ? item.agentId === agentId : true))
      .filter((item) => (workflowId ? item.workflowId === workflowId : true))
      .filter((item) => (sessionId ? item.sessionId === sessionId : true))
      .slice(-limit)
      .reverse();
  };

  return {
    mockRolePolicy,
    debugRuntimeModuleIds: DEFAULT_DEBUG_RUNTIME_MODULE_IDS,
    createMockChatCodexRunner,
    createAdaptiveChatCodexRunner,
    createMockRuntimeRoleModule,
    ensureDebugRuntimeModules,
    clearMockDispatchAssertions,
    listMockDispatchAssertions,
  };
}
