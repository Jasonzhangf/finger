import type { ModuleRegistry, OutputModule } from '../../../orchestration/module-registry.js';
import type { ChatCodexRunnerController, MockAgentRole, MockOutcome, MockRuntimeDeps } from './types.js';
import type { MockDispatchAssertion } from './types.js';
import { parseMockOutcome, pickMessageContext, DEFAULT_DEBUG_RUNTIME_MODULE_IDS } from './utils.js';
import { MockChatCodexRunner } from './mock-runner.js';
import { AdaptiveChatCodexRunner } from './adaptive-runner.js';

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

export function createMockRuntimeKit(deps: MockRuntimeDeps): MockRuntimeKit {
  const { getBroadcast, primaryOrchestratorAgentId, agentIds, maxAssertions = 400 } = deps;
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
    while (mockDispatchAssertions.length > maxAssertions) mockDispatchAssertions.shift();
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

  return {
    mockRolePolicy,
    debugRuntimeModuleIds: DEFAULT_DEBUG_RUNTIME_MODULE_IDS,
    createMockChatCodexRunner(): ChatCodexRunnerController {
      return new MockChatCodexRunner(deps, mockRolePolicy);
    },
    createAdaptiveChatCodexRunner(realRunner: ChatCodexRunnerController, mockRunner: ChatCodexRunnerController, shouldUseMock: () => boolean): ChatCodexRunnerController {
      return new AdaptiveChatCodexRunner(realRunner, mockRunner, shouldUseMock);
    },
    createMockRuntimeRoleModule(params: { id: string; name: string; role: MockAgentRole }): OutputModule {
      const { id, name, role } = params;
      return {
        id,
        type: 'output',
        name,
        version: '1.0.0',
        async handle(event) {
          if (event.type !== 'task_assigned') return;
          const taskPayload = event.payload as { task?: unknown };
          const result = mockRolePolicy[role] === 'success' ? { ok: true as const, summary: `Mock ${role} completed` } : { ok: false as const, summary: `Mock ${role} failed` };
          recordMockDispatchAssertion({ agentId: id, agentRole: role, message: taskPayload.task, result });
        },
      };
    },
    async ensureDebugRuntimeModules(enabled: boolean, moduleRegistry: ModuleRegistry): Promise<void> {
      for (const moduleId of DEFAULT_DEBUG_RUNTIME_MODULE_IDS) {
        const existing = moduleRegistry.getModule(moduleId);
        if (enabled && !existing) {
          const role = moduleId.includes('executor') ? 'executor' : moduleId.includes('reviewer') ? 'reviewer' : 'searcher';
          const mod = this.createMockRuntimeRoleModule({ id: moduleId, name: `Debug ${role}`, role });
          moduleRegistry.register(mod);
        } else if (!enabled && existing) {
          moduleRegistry.unregister(moduleId);
        }
      }
    },
    clearMockDispatchAssertions(): void {
      mockDispatchAssertions.length = 0;
    },
    listMockDispatchAssertions(filters: { agentId?: string; workflowId?: string; sessionId?: string; limit?: number }): MockDispatchAssertion[] {
      let results = [...mockDispatchAssertions];
      if (filters.agentId) results = results.filter(a => a.agentId === filters.agentId);
      if (filters.workflowId) results = results.filter(a => a.workflowId === filters.workflowId);
      if (filters.sessionId) results = results.filter(a => a.sessionId === filters.sessionId);
      if (filters.limit && filters.limit > 0) results = results.slice(-filters.limit);
      return results;
    },
  };
}
