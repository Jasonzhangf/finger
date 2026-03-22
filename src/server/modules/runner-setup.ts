/**
 * ChatCodex Runner Setup
 *
 * Creates the real and mock ChatCodex runners, and the mock runtime kit.
 * Returns the active chatCodexRunner and mockRuntimeKit for later use.
 */

import { ProcessChatCodexRunner } from '../../agents/finger-general/finger-general-module.js';
import { createMockRuntimeKit, type ChatCodexRunnerController } from './mock-runtime.js';
import type { DispatchTaskLike } from './mock-runtime/index.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { FINGER_GENERAL_AGENT_ID, FINGER_ORCHESTRATOR_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { resolveRuntimeFlags, shouldUseMockChatCodexRunner } from './server-flags.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';

export interface RunnerSetupResult {
  chatCodexRunner: ChatCodexRunnerController;
  mockRuntimeKit: ReturnType<typeof createMockRuntimeKit>;
}

export function setupChatCodexRunner(deps: {
  PORT: number;
  sessionManager: SessionManager;
  runtime: RuntimeFacade;
  eventBus: any;
  dispatchTaskToAgent: DispatchTaskLike;
  primaryOrchestratorAgentId: string;
  runtimeFlags: ReturnType<typeof resolveRuntimeFlags>;
}): RunnerSetupResult {
  const processChatCodexRunner = new ProcessChatCodexRunner({
    timeoutMs: 600_000,
    toolExecution: {
      daemonUrl: `http://127.0.0.1:${deps.PORT}`,
      agentId: FINGER_GENERAL_AGENT_ID,
    },
  });

  const mockRuntimeKit = createMockRuntimeKit({
    sessionManager: deps.sessionManager,
    dispatchTask: deps.dispatchTaskToAgent,
    eventBus: deps.eventBus,
    primaryOrchestratorAgentId: deps.primaryOrchestratorAgentId,
    agentIds: {
      researcher: FINGER_ORCHESTRATOR_AGENT_ID,
      executor: FINGER_ORCHESTRATOR_AGENT_ID,
      reviewer: FINGER_ORCHESTRATOR_AGENT_ID,
    },
  });

  const mockChatCodexRunner = mockRuntimeKit.createMockChatCodexRunner();
  const chatCodexRunner: ChatCodexRunnerController = mockRuntimeKit.createAdaptiveChatCodexRunner(
    processChatCodexRunner as unknown as ChatCodexRunnerController,
    mockChatCodexRunner,
    () => shouldUseMockChatCodexRunner(deps.runtimeFlags),
  );

  return { chatCodexRunner, mockRuntimeKit };
}
