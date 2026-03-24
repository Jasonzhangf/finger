import { AgentRuntimeBlock } from '../../blocks/index.js';
import { createOrchestrationConfigApplier } from './orchestration-config-applier.js';
import { registerMockRuntimeModules } from './mock-runtime-setup.js';
import type { MockAgentRole, MockOutcome } from './mock-runtime.js';
import { loadAutostartAgents } from '../../orchestration/autostart-loader.js';
import { logger } from '../../core/logger.js';
import { fallbackDispatchQueueTimeoutToMailbox } from './dispatch-queue-timeout-mailbox.js';

const log = logger.module('AgentRuntimeSetup');

export interface AgentRuntimeSetupResult {
  agentRuntimeBlock: AgentRuntimeBlock;
  applyOrchestrationConfig: ReturnType<typeof createOrchestrationConfigApplier>;
  mockRolePolicy: Record<MockAgentRole, MockOutcome>;
  DEBUG_RUNTIME_MODULE_IDS: readonly string[];
  ensureDebugRuntimeModules: (enabled: boolean) => Promise<void>;
}

export async function setupAgentRuntime(deps: {
  moduleRegistry: any;
  hub: any;
  runtime: any;
  toolRegistry: any;
  eventBus: any;
  workflowManager: any;
  sessionManager: any;
  chatCodexRunner: any;
  resourcePool: any;
  getLoadedAgentConfigs: () => any[];
  primaryOrchestratorAgentId: string;
  sessionWorkspaces: any;
  getAgentRuntimeDeps: () => any;
  mockRuntimeKit: any;
  systemAgentId: string;
  flags: {
    enableMockExecutor: boolean;
    enableMockReviewer: boolean;
    enableMockSearcher: boolean;
  };
}): Promise<AgentRuntimeSetupResult> {
  const agentRuntimeBlock = new AgentRuntimeBlock('agent-runtime-1', {
    moduleRegistry: deps.moduleRegistry,
    hub: deps.hub,
    runtime: deps.runtime,
    toolRegistry: deps.toolRegistry,
    eventBus: deps.eventBus,
    workflowManager: deps.workflowManager,
    sessionManager: deps.sessionManager,
    chatCodexRunner: deps.chatCodexRunner,
    resourcePool: deps.resourcePool,
    getLoadedAgentConfigs: deps.getLoadedAgentConfigs,
    primaryOrchestratorAgentId: deps.primaryOrchestratorAgentId,
    onDispatchQueueTimeout: fallbackDispatchQueueTimeoutToMailbox,
  });
  await agentRuntimeBlock.initialize();
  await agentRuntimeBlock.start();

  log.info('Attempting to deploy System Agent globally...', {
    agentId: deps.systemAgentId,
    scope: 'global',
    instanceCount: 1,
  });
  try {
    const deployResult = await agentRuntimeBlock.execute('deploy', {
      targetAgentId: deps.systemAgentId,
      scope: 'global',
      instanceCount: 1,
    }) as unknown as { success: boolean };
    if (deployResult?.success) {
      log.info('System Agent deployed successfully', {
        agentId: deps.systemAgentId,
        result: deployResult,
      });
    } else {
      log.error('System Agent deployment failed', undefined, {
        agentId: deps.systemAgentId,
        result: deployResult,
      });
    }
  } catch (err) {
    log.error('Failed to deploy System Agent', err instanceof Error ? err : undefined);
  }

  const applyOrchestrationConfig = createOrchestrationConfigApplier({
    agentRuntimeBlock,
    sessionManager: deps.sessionManager,
    sessionWorkspaces: deps.sessionWorkspaces,
  });
  const { mockRolePolicy, debugRuntimeModuleIds: DEBUG_RUNTIME_MODULE_IDS, ensureDebugRuntimeModules } =
    await registerMockRuntimeModules({
      mockRuntimeKit: deps.mockRuntimeKit,
      moduleRegistry: deps.moduleRegistry,
      flags: deps.flags,
    });

  await loadAutostartAgents(deps.moduleRegistry).catch(err => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Failed to load autostart agents', { error: message });
  });

  return {
    agentRuntimeBlock,
    applyOrchestrationConfig,
    mockRolePolicy,
    DEBUG_RUNTIME_MODULE_IDS,
    ensureDebugRuntimeModules,
  };
}
