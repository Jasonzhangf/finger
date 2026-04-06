import express from 'express';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registry } from '../core/registry.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { RuntimeFacade } from '../runtime/runtime-facade.js';
import { registerDefaultRuntimeTools } from '../runtime/default-tools.js';
import { ClockTaskInjector } from '../orchestration/clock-task-injector.js';

let clockInjector: ClockTaskInjector | null = null;
import {
  AGENT_JSON_SCHEMA,
  resolveDefaultAgentConfigDir,
} from '../runtime/agent-json-config.js';
import { ModuleRegistry } from '../orchestration/module-registry.js';
import { GatewayManager } from '../gateway/gateway-manager.js';
// SessionManager accessed via shared-instances
import { sharedWorkflowManager, sharedMessageHub, sharedSessionManager } from '../orchestration/shared-instances.js';
import { runtimeInstructionBus } from '../orchestration/runtime-instruction-bus.js';
import { AskManager } from '../orchestration/ask/ask-manager.js';
import { resourcePool } from '../orchestration/resource-pool.js';
import {
  loadOrchestrationConfig,
  type OrchestrationConfigV1,
} from '../orchestration/orchestration-config.js';
import { resumableSessionManager } from '../orchestration/resumable-session.js';
import { echoInput, echoOutput } from '../agents/test/mock-echo-agent.js';
import { memoryOutput } from '../outputs/memory.js';
import { createWebUIOutput } from '../outputs/webui.js';
import {
  FINGER_PROJECT_AGENT_ID,
  FINGER_PROJECT_ALLOWED_TOOLS,
  FINGER_REVIEWER_AGENT_ID,
  FINGER_REVIEWER_ALLOWED_TOOLS,
  FINGER_SYSTEM_AGENT_ID,
  FINGER_SYSTEM_ALLOWED_TOOLS,
} from '../agents/finger-general/finger-general-module.js';
import { mailbox } from './mailbox.js';
import { BdTools } from '../agents/shared/bd-tools.js';
import { inputLockManager } from '../runtime/input-lock.js';
import { createWebSocketServer } from './modules/websocket-server.js';
import { SYSTEM_AGENT_CONFIG } from '../agents/finger-system-agent/index.js';
import { HeartbeatBroker } from '../agents/core/heartbeat-broker.js';
import { AgentStatusSubscriber } from './modules/agent-status-subscriber.js';
import { SystemAgentManager } from './modules/system-agent-manager.js';
import { createSessionWorkspaceManager } from './modules/session-workspaces.js';
import { attachEventForwarding } from './modules/event-forwarding.js';
import { ensureSingleInstance } from './modules/port-guard.js';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { createSessionLoggingHelpers } from './modules/session-logging.js';
import { registerFingerRoleModules } from './modules/finger-role-modules.js';
import { createAgentConfigReloader } from './modules/agent-config-reloader.js';
import { registerDefaultModuleRoutes } from './modules/module-registry-bootstrap.js';
import { resolveRuntimeFlags, shouldUseMockChatCodexRunner } from './modules/server-flags.js';
import { HeartbeatScheduler } from './modules/heartbeat-scheduler.js';
import { ProgressMonitor, type ProgressReport } from './modules/progress-monitor.js';
import { ExecutionUpdateShadowPipeline } from './modules/execution-update-shadow-pipeline.js';
import { DailySummaryScheduler, createDailySummarySchedulerOptionsFromEnv } from './modules/daily-summary-scheduler.js';
import {
  loadChannelBridgeConfigs,
  registerChannelBridgeOutputs,
} from './modules/channel-bridge-bootstrap.js';
import { initOpenClawGate, writePidFile, cleanupPidFile } from './modules/server-lifecycle.js';
import { startServer } from './modules/server-startup.js';
import { setupChatCodexRunner } from './modules/runner-setup.js';
import { setupAgentRuntime } from './modules/agent-runtime-setup.js';
import { runPostInit } from './modules/server-postinit.js';
import {
  dispatchTaskToAgent as dispatchTaskToAgentModule,
  registerAgentRuntimeTools,
  createGetAgentRuntimeDeps,
} from './modules/agent-runtime/index.js';
import type { AgentDispatchRequest } from './modules/agent-runtime/types.js';
import { createChannelBridgeHubRoute } from './modules/channel-bridge-hub-route.js';
import { checkAIProviderConfig } from './modules/ai-provider-config.js';

import { ensureFingerLayout, FINGER_PATHS } from '../core/finger-paths.js';
import { sanitizeFingerRuntimeState } from '../core/runtime-hygiene.js';
import { syncUserSettingsToKernelConfig } from '../core/user-settings-sync.js';
import {
  ERROR_SAMPLE_DIR,
  BLOCKING_MESSAGE_TIMEOUT_MS,
  BLOCKING_MESSAGE_MAX_RETRIES,
  BLOCKING_MESSAGE_RETRY_BASE_MS,
  PRIMARY_ORCHESTRATOR_AGENT_ID,
  PRIMARY_ORCHESTRATOR_GATEWAY_ID,
  LEGACY_ORCHESTRATOR_AGENT_ID,
  LEGACY_ORCHESTRATOR_GATEWAY_ID,
  PRIMARY_ORCHESTRATOR_TARGET,
  ALLOW_DIRECT_AGENT_ROUTE,
  isPrimaryOrchestratorTarget,
} from './modules/server-constants.js';
import {
  asString,
  formatDispatchResultContent,
  inferAgentRoleLabel,
} from './modules/event-forwarding-helpers.js';
import {
  listKernelProviders,
  resolveActiveKernelProviderId,
  selectKernelProvider,
  testKernelProvider,
  upsertKernelProvider,
} from './provider-config.js';
import { OpenClawGateBlock, type OpenClawGateEvent } from '../blocks/openclaw-gate/index.js';
import { loadInputsConfig, loadOutputsConfig } from '../core/config-loader.js';
import { toOpenClawToolDefinition } from '../orchestration/openclaw-adapter/index.js';
import { initializeBlockRegistry } from './modules/block-registry-bootstrap.js';
import { getChannelBridgeManager, type ChannelBridgeConfig } from '../bridges/index.js';
import type { ChannelMessage } from '../bridges/types.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../core/logger.js';



const log = logger.module('Server');
type WebSocketServerRuntime = ReturnType<typeof createWebSocketServer>;
let wsClients: WebSocketServerRuntime['wsClients'];
let wss: WebSocketServerRuntime['wss'];
let broadcast: WebSocketServerRuntime['broadcast'] = () => {};

const runtimeFlags = resolveRuntimeFlags();
const ENABLE_FULL_MOCK_MODE = runtimeFlags.enableFullMockMode;
const ENABLE_LEGACY_CHAT_CODEX_ALIAS = runtimeFlags.enableLegacyChatCodexAlias;
const ENABLE_MOCK_EXECUTOR = runtimeFlags.enableMockExecutor;
const ENABLE_MOCK_REVIEWER = runtimeFlags.enableMockReviewer;
const ENABLE_MOCK_SEARCHER = runtimeFlags.enableMockSearcher;
const USE_MOCK_EXECUTOR_LOOP = runtimeFlags.useMockExecutorLoop;
const USE_MOCK_REVIEWER_LOOP = runtimeFlags.useMockReviewerLoop;
const USE_MOCK_SEARCHER_LOOP = runtimeFlags.useMockSearcherLoop;
let runtimeDebugMode = runtimeFlags.runtimeDebugMode;

ensureFingerLayout();
sanitizeFingerRuntimeState();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9999;
const HTTP_BODY_LIMIT = process.env.FINGER_HTTP_BODY_LIMIT || '20mb';
const LOCAL_IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};


const app = express();
app.use(express.json({ limit: HTTP_BODY_LIMIT }));

app.use(express.static(join(__dirname, '../../ui/dist')));
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, '../../ui/dist/index.html'));
});

app.use((req, _res, next) => {
  logger.module('server').debug(`${req.method} ${req.url}`);
  next();
});

// Initialize Channel Bridge Manager
const channelBridgeManager = getChannelBridgeManager({
  onMessage: async (msg: ChannelMessage) => {
    logger.module('channel-bridge').info('Received channel message', { msgId: msg.id, senderId: msg.senderId, channelId: msg.channelId });

    await hub.send({
      type: `channel.${msg.channelId}`,
      payload: msg,
      meta: {
        source: msg.channelId,
        id: msg.id,
      },
    });

    logger.module('channel-bridge').debug('Message sent to MessageHub');
  },
  onError: (err: Error) => {
    logger.module('channel-bridge').error('Channel bridge error', err instanceof Error ? err : undefined);
  },
  onReady: () => {
    logger.module('channel-bridge').info('Channel bridge ready');
  },
  onClose: () => {
    logger.module('channel-bridge').info('Channel bridge closed');
  },
});
await initializeBlockRegistry(registry);

const hub = sharedMessageHub;
const moduleRegistry = new ModuleRegistry(hub);
const sessionManager = sharedSessionManager;
const sessionWorkspaceManager = createSessionWorkspaceManager(sessionManager);
const {
  resolveSessionLoopLogPath,
  appendSessionLoopLog,
  writeMessageErrorSample,
  emitLoopEventToEventBus,
  setLoopEventEmitter,
} = createSessionLoggingHelpers({
  sessionWorkspaces: sessionWorkspaceManager,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  errorSampleDir: ERROR_SAMPLE_DIR,
  systemAgentId: FINGER_SYSTEM_AGENT_ID,
});
const workflowManager = sharedWorkflowManager;
const runtime = new RuntimeFacade(globalEventBus, sessionManager, globalToolRegistry);

// IMPORTANT:
// Context rebuild remains explicit (context_builder.rebuild), or one-time bootstrap
// on truly empty history only.
// Separately, runtime auto-compaction is enabled when context usage crosses threshold
// to avoid hard-overflow stalls during long turns.
const askManager = new AskManager(
  Number.isFinite(Number(process.env.FINGER_ASK_TOOL_TIMEOUT_MS))
    ? Math.max(1_000, Math.floor(Number(process.env.FINGER_ASK_TOOL_TIMEOUT_MS)))
    : 600_000,
);
const bdTools = new BdTools(process.cwd());
const gatewayManager = new GatewayManager(hub, moduleRegistry, {
  daemonUrl: `http://127.0.0.1:${PORT}`,
});
let agentRuntimeBlock: any;
const { reloadAgentJsonConfigs, getLoadedAgentConfigDir, getLoadedAgentConfigs } = createAgentConfigReloader({
  runtime,
  initialConfigDir: resolveDefaultAgentConfigDir(),
});

const getAgentRuntimeDeps = createGetAgentRuntimeDeps(
  () => agentRuntimeBlock,
  {
    runtime,
    sessionManager,
    sessionWorkspaces: sessionWorkspaceManager,
    askManager,
    eventBus: globalEventBus,
    runtimeInstructionBus,
    bdTools,
    broadcast: (message) => broadcast(message),
    primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
    isPrimaryOrchestratorTarget,
  },
);

const dispatchTaskToAgent = (input: AgentDispatchRequest) =>
  dispatchTaskToAgentModule(getAgentRuntimeDeps(), input);

const loadedTools = registerDefaultRuntimeTools(globalToolRegistry, getAgentRuntimeDeps);
logger.module('server').info('Runtime tools loaded', { tools: loadedTools.join(', ') });


let applyOrchestrationConfig: (config: OrchestrationConfigV1) => Promise<{
  applied: number;
  agents: string[];
  profileId: string;
}>;

reloadAgentJsonConfigs();
const activeKernelProviderId = resolveActiveKernelProviderId();
logger.module('server').info('Active kernel provider', { provider: activeKernelProviderId });
await moduleRegistry.register(echoInput);
await moduleRegistry.register(echoOutput);
await moduleRegistry.register(memoryOutput);

const { chatCodexRunner, mockRuntimeKit } = setupChatCodexRunner({
  PORT,
  sessionManager,
  runtime,
  eventBus: globalEventBus,
  dispatchTaskToAgent,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  runtimeFlags,
});
await registerFingerRoleModules({
  moduleRegistry,
  runtime,
  toolRegistry: globalToolRegistry,
  chatCodexRunner,
  daemonUrl: `http://127.0.0.1:${PORT}`,
  resolveSessionLedgerRoot: (session) => sharedSessionManager.resolveLedgerRootForSession(session.id) || undefined,
  onLoopEvent: (event) => {
    appendSessionLoopLog(event);
    emitLoopEventToEventBus(event);
  },
}, [
  { id: FINGER_PROJECT_AGENT_ID, roleProfile: 'project', allowedTools: FINGER_PROJECT_ALLOWED_TOOLS },
  { id: FINGER_REVIEWER_AGENT_ID, roleProfile: 'reviewer', allowedTools: FINGER_REVIEWER_ALLOWED_TOOLS },
  { id: FINGER_SYSTEM_AGENT_ID, roleProfile: 'system', allowedTools: FINGER_SYSTEM_ALLOWED_TOOLS },
], {
  enableLegacyChatCodexAlias: ENABLE_LEGACY_CHAT_CODEX_ALIAS,
  legacyAgentId: LEGACY_ORCHESTRATOR_AGENT_ID,
  legacyAllowedTools: FINGER_PROJECT_ALLOWED_TOOLS,
});
logger.module('server').info('Finger runner mode', { mode: shouldUseMockChatCodexRunner(runtimeFlags) ? 'mock' : 'real' });

const agentRuntimeSetup = await setupAgentRuntime({
  moduleRegistry,
  hub,
  runtime,
  toolRegistry: globalToolRegistry,
  eventBus: globalEventBus,
  workflowManager,
  sessionManager,
  chatCodexRunner,
  resourcePool,
  getLoadedAgentConfigs,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  sessionWorkspaces: sessionWorkspaceManager,
  getAgentRuntimeDeps,
  mockRuntimeKit,
  systemAgentId: FINGER_SYSTEM_AGENT_ID,
  flags: {
    enableMockExecutor: ENABLE_MOCK_EXECUTOR,
    enableMockReviewer: ENABLE_MOCK_REVIEWER,
    enableMockSearcher: ENABLE_MOCK_SEARCHER,
  },
});
agentRuntimeBlock = agentRuntimeSetup.agentRuntimeBlock;
applyOrchestrationConfig = agentRuntimeSetup.applyOrchestrationConfig;
const { mockRolePolicy, DEBUG_RUNTIME_MODULE_IDS, ensureDebugRuntimeModules } = agentRuntimeSetup;
const agentRuntimeTools = registerAgentRuntimeTools(getAgentRuntimeDeps());
logger.module('server').info('Agent runtime tools loaded', { tools: agentRuntimeTools.join(', ') });



// Start Clock Task Injector
clockInjector = new ClockTaskInjector({
  dispatchTaskToAgent,
  ensureSession: (sessionId, projectPath) => {
    sessionManager.ensureSession(sessionId, projectPath);
  },
  log: (message, data) => logger.module('clock-injector').info(message, data ? { data } : undefined),
});
clockInjector.start();
logger.module('server').info('Clock Task Injector started');

// Start System Agent periodic checks
const systemAgentManager = new SystemAgentManager(getAgentRuntimeDeps());
await systemAgentManager.start();
logger.module('server').info('System Agent Manager started');

// Start Agent Status Subscriber
const agentStatusSubscriber = new AgentStatusSubscriber(globalEventBus, getAgentRuntimeDeps(), hub, channelBridgeManager, broadcast);
agentStatusSubscriber.start();
agentStatusSubscriber.setPrimaryAgent(SYSTEM_AGENT_CONFIG.id);
logger.module('server').info('Agent Status Subscriber started');

// Start Heartbeat Scheduler
export const heartbeatScheduler = new HeartbeatScheduler(getAgentRuntimeDeps());
await heartbeatScheduler.start();
logger.module('server').info('Heartbeat Scheduler started');

// Start Progress Monitor
const progressMonitor = new ProgressMonitor(globalEventBus, getAgentRuntimeDeps(), {
  onProgressReport: async (report: ProgressReport) => {
    await agentStatusSubscriber.sendProgressUpdate({
      sessionId: report.sessionId,
      agentId: report.agentId,
      summary: report.summary,
      progress: {
        status: report.progress.status,
        toolCallsCount: report.progress.toolCallsCount,
        modelRoundsCount: report.progress.modelRoundsCount,
        elapsedMs: report.progress.elapsedMs,
        contextUsagePercent: report.progress.contextUsagePercent,
        estimatedTokensInContextWindow: report.progress.estimatedTokensInContextWindow,
        maxInputTokens: report.progress.maxInputTokens,
        contextBreakdown: report.progress.contextBreakdown,
      },
    });
  },
});
progressMonitor.start();
logger.module('server').info('Progress Monitor started');

// Start canonical execution update shadow pipeline (phase A: shadow mode).
const executionUpdatePipeline = new ExecutionUpdateShadowPipeline(globalEventBus, getAgentRuntimeDeps());
executionUpdatePipeline.start();
logger.module('server').info('Execution update shadow pipeline started');

// Start built-in daily summary scheduler (replaces external cron scripts for daily retrospectives)
const dailySummaryScheduler = new DailySummaryScheduler(
  {
    dispatchTaskToAgent: (input) => dispatchTaskToAgent(input),
  },
  createDailySummarySchedulerOptionsFromEnv(),
);
dailySummaryScheduler.start();
logger.module('server').info('Daily summary scheduler started');

await gatewayManager.start().catch((err) => {
  logger.module('server').error('Failed to start gateway manager', err instanceof Error ? err : undefined);
});

registerDefaultModuleRoutes(moduleRegistry);
const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 9998;
// WebSocket server cleanup
await ensureSingleInstance(wsPort);

({ wss, wsClients, broadcast } = createWebSocketServer({
  port: wsPort,
  serverPort: PORT,
  eventBus: globalEventBus,
  mailbox,
  inputLockManager,
}));

// Register WebUI output module (broadcast to WebSocket clients)
const webuiOutput = createWebUIOutput({ broadcast });
await moduleRegistry.register(webuiOutput);
logger.module('server').info('WebUI output module registered for WebSocket broadcast');

const registerAllRoutesDeps = {
  sessionManager, runtime, eventBus: globalEventBus, logsDir: join(FINGER_PATHS.logs.dir, 'sessions'), resolveSessionLoopLogPath,
  hub, mailbox, sessionWorkspaces: sessionWorkspaceManager, broadcast, writeMessageErrorSample,
  blockingTimeoutMs: BLOCKING_MESSAGE_TIMEOUT_MS, blockingMaxRetries: BLOCKING_MESSAGE_MAX_RETRIES, blockingRetryBaseMs: BLOCKING_MESSAGE_RETRY_BASE_MS,
  allowDirectAgentRoute: ALLOW_DIRECT_AGENT_ROUTE, primaryOrchestratorTarget: PRIMARY_ORCHESTRATOR_TARGET, primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  primaryOrchestratorGatewayId: PRIMARY_ORCHESTRATOR_GATEWAY_ID, legacyOrchestratorAgentId: LEGACY_ORCHESTRATOR_AGENT_ID, legacyOrchestratorGatewayId: LEGACY_ORCHESTRATOR_GATEWAY_ID,
  progressMonitor,
  workflowManager, askManager, runtimeInstructionBus, moduleRegistry, gatewayManager, channelBridgeManager, inputLockManager, toolRegistry: globalToolRegistry,
  resumableSessionManager, wsClients, applyOrchestrationConfig, getChatCodexRunnerMode: () => (shouldUseMockChatCodexRunner(runtimeFlags) ? 'mock' : 'real'),
  getLoadedAgentConfigDir, getLoadedAgentConfigs, agentJsonSchema: AGENT_JSON_SCHEMA, reloadAgentJsonConfigs, wss, registry, getAgentRuntimeDeps, resourcePool,
  runtimeDebug: { get: () => runtimeDebugMode, set: async (enabled: boolean) => { runtimeDebugMode = enabled; await ensureDebugRuntimeModules(runtimeDebugMode); }, moduleIds: DEBUG_RUNTIME_MODULE_IDS },
  mockRuntime: { rolePolicy: mockRolePolicy, clearAssertions: () => mockRuntimeKit.clearMockDispatchAssertions(), listAssertions: (filters: any) => mockRuntimeKit.listMockDispatchAssertions(filters) },
  flags: { enableFullMockMode: ENABLE_FULL_MOCK_MODE, useMockExecutorLoop: USE_MOCK_EXECUTOR_LOOP, useMockReviewerLoop: USE_MOCK_REVIEWER_LOOP, useMockSearcherLoop: USE_MOCK_SEARCHER_LOOP },
  interruptSession: async (sessionId: string) => chatCodexRunner.interruptSession(sessionId),
  system: { localImageMimeByExt: LOCAL_IMAGE_MIME_BY_EXT, listKernelProviders, upsertKernelProvider, selectKernelProvider, testKernelProvider },
};
await ensureSingleInstance(PORT);
// Start heartbeat broker for child process lifecycle management
const heartbeatBroker = new HeartbeatBroker();
heartbeatBroker.start();
logger.module('server').info('Heartbeat broker started', { port: 9998 });

startServer(app, process.env.HOST || '0.0.0.0', PORT, {
  chatCodexRunner,
  clockInjector,
  agentStatusSubscriber,
  heartbeatScheduler,
  progressMonitor,
  executionUpdatePipeline,
  dailySummaryScheduler,
});

logger.module('server').info('Finger role modules ready', {
  agents: [FINGER_PROJECT_AGENT_ID, FINGER_REVIEWER_AGENT_ID, FINGER_SYSTEM_AGENT_ID].join(', '),
});
try {
  const loadedOrchestrationConfig = loadOrchestrationConfig();
  const applied = await applyOrchestrationConfig(loadedOrchestrationConfig.config);
  logger.module('server').info('Orchestration config applied', {
    path: loadedOrchestrationConfig.path,
    created: loadedOrchestrationConfig.created,
    appliedAgents: applied.agents,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logger.module('server').fatal('Invalid orchestration.json; startup aborted', undefined, { message });
  process.exit(1);
}

await runPostInit({
  hub,
  channelBridgeManager,
  askManager,
  eventBus: globalEventBus,
  sessionManager,
  runtime,
  dispatchTaskToAgent,
  broadcast,
  agentStatusSubscriber,
  applyOrchestrationConfig,
  generalAgentId: FINGER_PROJECT_AGENT_ID,
  setLoopEventEmitter,
  runtimeInstructionBus,
  app,
  registerAllRoutesDeps,
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.module('server').fatal('Post-init failed', undefined, { message });
  process.exit(1);
});
