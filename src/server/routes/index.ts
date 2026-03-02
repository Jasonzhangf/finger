import type { Express } from 'express';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ModuleRegistry } from '../../orchestration/module-registry.js';
import type { GatewayManager } from '../../gateway/gateway-manager.js';
import type { AskManager } from '../../orchestration/ask/ask-manager.js';
import type { WorkflowManager } from '../../orchestration/workflow-manager.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { SessionWorkspaceManager } from '../modules/session-workspaces.js';
import type { Mailbox } from '../mailbox.js';
import type { InputLockManager } from '../../runtime/input-lock.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { ResumableSessionManager } from '../../orchestration/resumable-session.js';
import type { OrchestrationConfigV1 } from '../../orchestration/orchestration-config.js';
import type { LoadedAgentConfig } from '../../runtime/agent-json-config.js';
import type { BlockRegistry } from '../../core/registry.js';
import type { WebSocket } from 'ws';
import type { AgentRuntimeDeps } from '../modules/agent-runtime/types.js';
import type { ResourcePool } from '../../orchestration/resource-pool.js';
import type { MockAgentRole, MockOutcome } from '../modules/mock-runtime.js';
import type { UpsertProviderInput, ProviderConfigRecord } from '../provider-config.js';
import { registerSessionRoutes } from './session.js';
import { registerSystemRoutes } from './system.js';
import { registerMessageRoutes } from './message.js';
import { registerAgentCliRoutes } from './agent-cli.js';
import { registerAgentRuntimeRoutes } from './agent-runtime/index.js';
import { registerWorkflowRoutes } from './workflow.js';
import { registerGatewayRoutes } from './gateway.js';
import { registerRuntimeEventRoutes } from './runtime-events.js';
import { registerToolRoutes } from './tools.js';
import { registerResumableSessionRoutes } from './resumable-session.js';
import { registerOrchestrationRoutes } from './orchestration.js';
import { registerAgentConfigRoutes } from './agent-configs.js';
import { registerModuleRegistryRoutes } from './module-registry.js';
import { registerPerformanceRoutes } from './performance.js';
import { registerWorkflowStateRoutes } from './workflow-state.js';
import { registerDebugRoutes } from './debug.js';

export interface RegisterAllRoutesDeps {
  sessionManager: SessionManager;
  runtime: RuntimeFacade;
  eventBus: UnifiedEventBus;
  logsDir: string;
  resolveSessionLoopLogPath: (sessionId: string) => string;
  hub: MessageHub;
  mailbox: Mailbox;
  sessionWorkspaces: SessionWorkspaceManager;
  broadcast: (message: Record<string, unknown>) => void;
  writeMessageErrorSample: (payload: Record<string, unknown>) => void;
  blockingTimeoutMs: number;
  blockingMaxRetries: number;
  blockingRetryBaseMs: number;
  allowDirectAgentRoute: boolean;
  primaryOrchestratorTarget: string;
  primaryOrchestratorAgentId: string;
  primaryOrchestratorGatewayId: string;
  legacyOrchestratorAgentId: string;
  legacyOrchestratorGatewayId: string;
  workflowManager: WorkflowManager;
  askManager: AskManager;
  runtimeInstructionBus: typeof import('../../orchestration/runtime-instruction-bus.js').runtimeInstructionBus;
  moduleRegistry: ModuleRegistry;
  gatewayManager: GatewayManager;
  inputLockManager: InputLockManager;
  toolRegistry: ToolRegistry;
  resumableSessionManager: ResumableSessionManager;
  wsClients: Set<WebSocket>;
  applyOrchestrationConfig: (config: OrchestrationConfigV1) => Promise<{
    applied: number;
    agents: string[];
    profileId: string;
  }>;
  getChatCodexRunnerMode: () => 'mock' | 'real';
  getLoadedAgentConfigDir: () => string;
  getLoadedAgentConfigs: () => LoadedAgentConfig[];
  agentJsonSchema: Record<string, unknown>;
  reloadAgentJsonConfigs: (configDir?: string) => void;
  wss: import('ws').WebSocketServer;
  registry: BlockRegistry;
  getAgentRuntimeDeps: () => AgentRuntimeDeps;
  resourcePool: ResourcePool;
  runtimeDebug: {
    get: () => boolean;
    set: (enabled: boolean) => Promise<void>;
    moduleIds: readonly string[];
  };
  mockRuntime: {
    rolePolicy: Record<MockAgentRole, MockOutcome>;
    clearAssertions: () => void;
    listAssertions: (filters: {
      agentId?: string;
      workflowId?: string;
      sessionId?: string;
      limit?: number;
    }) => unknown[];
  };
  flags: {
    enableFullMockMode: boolean;
    useMockExecutorLoop: boolean;
    useMockReviewerLoop: boolean;
    useMockSearcherLoop: boolean;
  };
  system: {
    localImageMimeByExt: Record<string, string>;
    listKernelProviders: () => unknown;
    upsertKernelProvider: (input: UpsertProviderInput) => ProviderConfigRecord;
    selectKernelProvider: (providerId: string) => ProviderConfigRecord;
    testKernelProvider: (providerId: string) => Promise<{ success: boolean; message: string }>;
  };
}

export function registerAllRoutes(app: Express, deps: RegisterAllRoutesDeps): void {
  registerSessionRoutes(app, {
    sessionManager: deps.sessionManager,
    runtime: deps.runtime,
    eventBus: deps.eventBus,
    logsDir: deps.logsDir,
    resolveSessionLoopLogPath: deps.resolveSessionLoopLogPath,
  });

  registerMessageRoutes(app, {
    hub: deps.hub,
    mailbox: deps.mailbox,
    runtime: deps.runtime,
    sessionManager: deps.sessionManager,
    sessionWorkspaces: deps.sessionWorkspaces,
    broadcast: deps.broadcast,
    writeMessageErrorSample: deps.writeMessageErrorSample,
    blockingTimeoutMs: deps.blockingTimeoutMs,
    blockingMaxRetries: deps.blockingMaxRetries,
    blockingRetryBaseMs: deps.blockingRetryBaseMs,
    allowDirectAgentRoute: deps.allowDirectAgentRoute,
    primaryOrchestratorTarget: deps.primaryOrchestratorTarget,
    primaryOrchestratorAgentId: deps.primaryOrchestratorAgentId,
    primaryOrchestratorGatewayId: deps.primaryOrchestratorGatewayId,
    legacyOrchestratorAgentId: deps.legacyOrchestratorAgentId,
    legacyOrchestratorGatewayId: deps.legacyOrchestratorGatewayId,
  });

  registerAgentCliRoutes(app);

  registerWorkflowRoutes(app, {
    workflowManager: deps.workflowManager,
    askManager: deps.askManager,
    runtimeInstructionBus: deps.runtimeInstructionBus,
    broadcast: deps.broadcast,
    primaryOrchestratorAgentId: deps.primaryOrchestratorAgentId,
  });

  registerGatewayRoutes(app, {
    hub: deps.hub,
    moduleRegistry: deps.moduleRegistry,
    gatewayManager: deps.gatewayManager,
  });

  registerRuntimeEventRoutes(app, {
    eventBus: deps.eventBus,
    inputLockManager: deps.inputLockManager,
    mailbox: deps.mailbox,
  });

  registerToolRoutes(app, {
    toolRegistry: deps.toolRegistry,
    runtime: deps.runtime,
  });

  registerResumableSessionRoutes(app, {
    resumableSessionManager: deps.resumableSessionManager,
    wsClients: deps.wsClients,
  });

  registerOrchestrationRoutes(app, {
    applyOrchestrationConfig: deps.applyOrchestrationConfig,
    primaryOrchestratorAgentId: deps.primaryOrchestratorAgentId,
    getChatCodexRunnerMode: deps.getChatCodexRunnerMode,
  });

  registerAgentConfigRoutes(app, {
    getLoadedAgentConfigDir: deps.getLoadedAgentConfigDir,
    getLoadedAgentConfigs: deps.getLoadedAgentConfigs,
    agentJsonSchema: deps.agentJsonSchema,
    reloadAgentJsonConfigs: deps.reloadAgentJsonConfigs,
  });

  registerModuleRegistryRoutes(app, {
    moduleRegistry: deps.moduleRegistry,
  });

  registerPerformanceRoutes(app, {
    wsClients: deps.wsClients,
  });

  registerWorkflowStateRoutes(app, {
    wss: deps.wss,
  });

  registerDebugRoutes(app, {
    registry: deps.registry,
  });

  registerAgentRuntimeRoutes(app, {
    getAgentRuntimeDeps: deps.getAgentRuntimeDeps,
    moduleRegistry: deps.moduleRegistry,
    resourcePool: deps.resourcePool,
    runtimeDebug: deps.runtimeDebug,
    mockRuntime: deps.mockRuntime,
    flags: deps.flags,
  });

  registerSystemRoutes(app, {
    registry: deps.registry,
    localImageMimeByExt: deps.system.localImageMimeByExt,
    listKernelProviders: deps.system.listKernelProviders,
    upsertKernelProvider: deps.system.upsertKernelProvider,
    selectKernelProvider: deps.system.selectKernelProvider,
    testKernelProvider: deps.system.testKernelProvider,
  });
}
