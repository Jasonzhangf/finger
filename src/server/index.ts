import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registry } from '../core/registry.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { RuntimeFacade } from '../runtime/runtime-facade.js';
import { registerDefaultRuntimeTools } from '../runtime/default-tools.js';
import {
  AGENT_JSON_SCHEMA,
  resolveDefaultAgentConfigDir,
} from '../runtime/agent-json-config.js';
import { ModuleRegistry } from '../orchestration/module-registry.js';
import { GatewayManager } from '../gateway/gateway-manager.js';
// SessionManager accessed via shared-instances
import { loadAutostartAgents } from '../orchestration/autostart-loader.js';
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
import {
  FINGER_CODER_AGENT_ID,
  FINGER_CODER_ALLOWED_TOOLS,
  FINGER_EXECUTOR_AGENT_ID,
  FINGER_EXECUTOR_ALLOWED_TOOLS,
  FINGER_GENERAL_AGENT_ID,
  FINGER_GENERAL_ALLOWED_TOOLS,
  FINGER_ORCHESTRATOR_AGENT_ID,
  FINGER_ORCHESTRATOR_ALLOWED_TOOLS,
  FINGER_RESEARCHER_AGENT_ID,
  FINGER_RESEARCHER_ALLOWED_TOOLS,
  FINGER_REVIEWER_AGENT_ID,
  FINGER_REVIEWER_ALLOWED_TOOLS,
  FINGER_SYSTEM_AGENT_ID,
  FINGER_SYSTEM_ALLOWED_TOOLS,
  ProcessChatCodexRunner,
} from '../agents/finger-general/finger-general-module.js';
import { mailbox } from './mailbox.js';
import { BdTools } from '../agents/shared/bd-tools.js';
import { inputLockManager } from '../runtime/input-lock.js';
import { createWebSocketServer } from './modules/websocket-server.js';
import { createSessionWorkspaceManager } from './modules/session-workspaces.js';
import { attachEventForwarding } from './modules/event-forwarding.js';
import { createMockRuntimeKit, type ChatCodexRunnerController } from './modules/mock-runtime.js';
import { ensureSingleInstance } from './modules/port-guard.js';
import { createOrchestrationConfigApplier } from './modules/orchestration-config-applier.js';
import { createSessionLoggingHelpers } from './modules/session-logging.js';
import { registerFingerRoleModules } from './modules/finger-role-modules.js';
import { createAgentConfigReloader } from './modules/agent-config-reloader.js';
import { registerDefaultModuleRoutes } from './modules/module-registry-bootstrap.js';
import { resolveRuntimeFlags, shouldUseMockChatCodexRunner } from './modules/server-flags.js';
import { registerMockRuntimeModules } from './modules/mock-runtime-setup.js';
import {
  dispatchTaskToAgent as dispatchTaskToAgentModule,
  registerAgentRuntimeTools,
  createGetAgentRuntimeDeps,
} from './modules/agent-runtime/index.js';
import type { AgentDispatchRequest } from './modules/agent-runtime/types.js';
import { registerAllRoutes } from './routes/index.js';
import { ensureFingerLayout, FINGER_PATHS } from '../core/finger-paths.js';
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
import { AgentRuntimeBlock } from '../blocks/index.js';
import { OpenClawGateBlock, type OpenClawGateEvent } from '../blocks/openclaw-gate/index.js';
import { loadInputsConfig, loadOutputsConfig } from '../core/config-loader.js';
import { toOpenClawToolDefinition } from '../orchestration/openclaw-adapter/index.js';
import { initializeBlockRegistry } from './modules/block-registry-bootstrap.js';
import { getChannelBridgeManager, type ChannelBridgeConfig } from '../bridges/index.js';
import type { ChannelMessage } from '../bridges/types.js';
import fs from 'fs';
import path from 'path';


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
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Initialize Channel Bridge Manager
const channelBridgeManager = getChannelBridgeManager({
  onMessage: async (msg: ChannelMessage) => {
    console.log('[Server] Received channel message:', msg.id, 'from', msg.senderId);
    
    // Route message to orchestrator agent
    try {
      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: msg.content },
        sessionId: `qqbot-${msg.senderId}`,
        metadata: {
          source: 'channel',
          channelId: msg.channelId,
          senderId: msg.senderId,
          senderName: msg.senderName,
          messageId: msg.id,
          type: msg.type,
        },
      };
      
      console.log('[Server] Dispatching to orchestrator:', dispatchRequest.targetAgentId);
      const result = await dispatchTaskToAgent(dispatchRequest);
      console.log('[Server] Dispatch result:', result?.status, result?.dispatchId);
      
      // Send response back to channel if we got a reply
      if (result?.ok && result.result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : (result.result.summary || '处理完成');
        console.log('[Server] Sending reply to channel:', replyText.slice(0, 100));
        
        // Determine target based on message type
        let target = msg.senderId;
        if (msg.type === 'group' && msg.metadata?.groupId) {
          target = `group:${msg.metadata.groupId}`;
        }
        
        try {
          const sendResult = await channelBridgeManager.sendMessage('qqbot', {
            to: target,
            text: replyText,
            replyTo: msg.id,
          });
          console.log('[Server] Reply sent:', sendResult.messageId);
        } catch (sendErr) {
          console.error('[Server] Failed to send reply:', sendErr);
        }
      } else {
        console.log('[Server] No response to send back, result:', result);
      }
    } catch (err) {
      console.error('[Server] Failed to dispatch message:', err);
    }
  },
  onError: (err: Error) => {
    console.error('[Server] Channel bridge error:', err);
  },
  onReady: () => {
    console.log('[Server] Channel bridge ready');
  },
  onClose: () => {
    console.log('[Server] Channel bridge closed');
  },
});

async function loadChannelBridgeConfigs(): Promise<void> {
  console.log('[Server] loadChannelBridgeConfigs called');
  const channelsConfigPath = path.join(FINGER_PATHS.config.dir, 'channels.json');
  let configs: ChannelBridgeConfig[] = [];

  try {
    if (fs.existsSync(channelsConfigPath)) {
      const raw = fs.readFileSync(channelsConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      configs = parsed.channels || [];
      console.log('[Server] Found channels config file, channels:', configs.length);
    } else {
      console.log('[Server] channels.json not found at:', channelsConfigPath);
    }
  } catch (err) {
    console.warn('[Server] Failed to load channels config:', err);
  }

  if (configs.length > 0) {
    console.log('[Server] Loading channel bridge configs...');
    try {
      await channelBridgeManager.loadConfigs(configs);
      console.log('[Server] Loaded', configs.length, 'channel bridge configs successfully');
    } catch (err) {
      console.error('[Server] Failed to load channel bridges:', err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log('[Server] No channel bridge configs to load');
  }
}

// Initialize OpenClaw Gate lazily after server start
const inputsCfg = loadInputsConfig();
const outputsCfg = loadOutputsConfig();

const openClawInputConfig = inputsCfg.inputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
const openClawOutputConfig = outputsCfg.outputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
const openClawPluginDir = openClawInputConfig?.pluginDir ?? openClawOutputConfig?.pluginDir;

console.log('[Server] OpenClaw plugin dir:', openClawPluginDir);

// Delay OpenClaw gate init until after server is listening
async function initOpenClawGate(): Promise<void> {
  if (!openClawPluginDir) return;
  const openClawGate = new OpenClawGateBlock('openclaw-gate', { pluginDir: openClawPluginDir });
  try {
    await openClawGate.initialize();
    openClawGate.addEventListener((event: OpenClawGateEvent) => {
      switch (event.type) {
        case 'plugin_enabled':
        case 'plugin_installed':
          for (const tool of event.tools) {
            globalToolRegistry.register(toOpenClawToolDefinition(event.pluginId, tool, openClawGate));
          }
          break;
        case 'plugin_disabled':
        case 'plugin_uninstalled':
          for (const toolName of event.toolNames) {
            globalToolRegistry.unregister(toolName);
          }
          break;
      }
    });

    console.log('[Server] OpenClaw Gate initialized, plugins:', openClawGate.listPlugins().length);
  } catch (err) {
    console.error('[Server] Failed to initialize OpenClaw Gate:', err instanceof Error ? err.message : String(err));
  }

  // Load channel bridge configs after OpenClaw gate is ready
  await loadChannelBridgeConfigs();
}

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

globalEventBus.subscribe('system_notice', (event) => {
  const payload = (typeof event.payload === 'object' && event.payload !== null)
    ? event.payload as Record<string, unknown>
    : {};
  if (payload.source !== 'auto_compact_probe') return;
  const contextUsagePercent = typeof payload.contextUsagePercent === 'number'
    ? payload.contextUsagePercent
    : undefined;
  const turnId = typeof payload.turnId === 'string' ? payload.turnId : undefined;
  void runtime.maybeAutoCompact(event.sessionId, contextUsagePercent, turnId);
});
const askManager = new AskManager(
  Number.isFinite(Number(process.env.FINGER_ASK_TOOL_TIMEOUT_MS))
    ? Math.max(1_000, Math.floor(Number(process.env.FINGER_ASK_TOOL_TIMEOUT_MS)))
    : 600_000,
);
const bdTools = new BdTools(process.cwd());
const loadedTools = registerDefaultRuntimeTools(globalToolRegistry);
console.log(`[Server] Runtime tools loaded: ${loadedTools.join(', ')}`);
const gatewayManager = new GatewayManager(hub, moduleRegistry, {
  daemonUrl: `http://127.0.0.1:${PORT}`,
});
let agentRuntimeBlock: AgentRuntimeBlock;
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



let applyOrchestrationConfig: (config: OrchestrationConfigV1) => Promise<{
  applied: number;
  agents: string[];
  profileId: string;
}>;

reloadAgentJsonConfigs();
const activeKernelProviderId = resolveActiveKernelProviderId();
console.log(`[Server] Active kernel provider: ${activeKernelProviderId}`);
await moduleRegistry.register(echoInput);
await moduleRegistry.register(echoOutput);
const processChatCodexRunner = new ProcessChatCodexRunner({
  timeoutMs: 600_000,
  toolExecution: {
    daemonUrl: `http://127.0.0.1:${PORT}`,
    agentId: FINGER_GENERAL_AGENT_ID,
  },
});
const mockRuntimeKit = createMockRuntimeKit({
  dispatchTask: dispatchTaskToAgent,
  eventBus: globalEventBus,
  sessionManager,
  getBroadcast: () => broadcast,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  agentIds: {
    researcher: FINGER_RESEARCHER_AGENT_ID,
    executor: FINGER_EXECUTOR_AGENT_ID,
    reviewer: FINGER_REVIEWER_AGENT_ID,
  },
});
const mockChatCodexRunner = mockRuntimeKit.createMockChatCodexRunner();
const chatCodexRunner: ChatCodexRunnerController = mockRuntimeKit.createAdaptiveChatCodexRunner(
  processChatCodexRunner as unknown as ChatCodexRunnerController,
  mockChatCodexRunner,
  () => shouldUseMockChatCodexRunner(runtimeFlags),
);
await registerFingerRoleModules({
  moduleRegistry,
  runtime,
  toolRegistry: globalToolRegistry,
  chatCodexRunner,
  daemonUrl: `http://127.0.0.1:${PORT}`,
  onLoopEvent: (event) => {
    appendSessionLoopLog(event);
    emitLoopEventToEventBus(event);
  },
}, [
  { id: FINGER_GENERAL_AGENT_ID, roleProfile: 'general', allowedTools: FINGER_GENERAL_ALLOWED_TOOLS },
  { id: FINGER_ORCHESTRATOR_AGENT_ID, roleProfile: 'orchestrator', allowedTools: FINGER_ORCHESTRATOR_ALLOWED_TOOLS },
  { id: FINGER_RESEARCHER_AGENT_ID, roleProfile: 'researcher', allowedTools: FINGER_RESEARCHER_ALLOWED_TOOLS },
  { id: FINGER_EXECUTOR_AGENT_ID, roleProfile: 'executor', allowedTools: FINGER_EXECUTOR_ALLOWED_TOOLS },
  { id: FINGER_CODER_AGENT_ID, roleProfile: 'coder', allowedTools: FINGER_CODER_ALLOWED_TOOLS },
  { id: FINGER_REVIEWER_AGENT_ID, roleProfile: 'reviewer', allowedTools: FINGER_REVIEWER_ALLOWED_TOOLS },
  { id: FINGER_SYSTEM_AGENT_ID, roleProfile: 'system', allowedTools: FINGER_SYSTEM_ALLOWED_TOOLS },
], {
  enableLegacyChatCodexAlias: ENABLE_LEGACY_CHAT_CODEX_ALIAS,
  legacyAgentId: LEGACY_ORCHESTRATOR_AGENT_ID,
  legacyAllowedTools: FINGER_GENERAL_ALLOWED_TOOLS,
});
console.log(`[Server] Finger runner mode: ${shouldUseMockChatCodexRunner(runtimeFlags) ? 'mock' : 'real'} (profile/env aware)`);

agentRuntimeBlock = new AgentRuntimeBlock('agent-runtime-1', {
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
});
await agentRuntimeBlock.initialize();
await agentRuntimeBlock.start();
applyOrchestrationConfig = createOrchestrationConfigApplier({
  agentRuntimeBlock,
  sessionManager,
  sessionWorkspaces: sessionWorkspaceManager,
});
const agentRuntimeTools = registerAgentRuntimeTools(getAgentRuntimeDeps());
console.log(`[Server] Agent runtime tools loaded: ${agentRuntimeTools.join(', ')}`);

const { mockRolePolicy, debugRuntimeModuleIds: DEBUG_RUNTIME_MODULE_IDS, ensureDebugRuntimeModules } = await registerMockRuntimeModules({
  mockRuntimeKit,
  moduleRegistry,
  flags: {
    enableMockExecutor: ENABLE_MOCK_EXECUTOR,
    enableMockReviewer: ENABLE_MOCK_REVIEWER,
    enableMockSearcher: ENABLE_MOCK_SEARCHER,
  },
});

// 加载 autostart agents
await loadAutostartAgents(moduleRegistry).catch(err => {
  console.error('[Server] Failed to load autostart agents:', err);
});

await gatewayManager.start().catch((err) => {
  console.error('[Server] Failed to start gateway manager:', err);
});

registerDefaultModuleRoutes(moduleRegistry);
const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 9998;
({ wss, wsClients, broadcast } = createWebSocketServer({
  port: wsPort,
  serverPort: PORT,
  eventBus: globalEventBus,
  mailbox,
  inputLockManager,
}));
registerAllRoutes(app, {
  sessionManager,
  runtime,
  eventBus: globalEventBus,
  logsDir: join(FINGER_PATHS.logs.dir, 'sessions'),
  resolveSessionLoopLogPath,
  hub,
  mailbox,
  sessionWorkspaces: sessionWorkspaceManager,
  broadcast,
  writeMessageErrorSample,
  blockingTimeoutMs: BLOCKING_MESSAGE_TIMEOUT_MS,
  blockingMaxRetries: BLOCKING_MESSAGE_MAX_RETRIES,
  blockingRetryBaseMs: BLOCKING_MESSAGE_RETRY_BASE_MS,
  allowDirectAgentRoute: ALLOW_DIRECT_AGENT_ROUTE,
  primaryOrchestratorTarget: PRIMARY_ORCHESTRATOR_TARGET,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
  primaryOrchestratorGatewayId: PRIMARY_ORCHESTRATOR_GATEWAY_ID,
  legacyOrchestratorAgentId: LEGACY_ORCHESTRATOR_AGENT_ID,
  legacyOrchestratorGatewayId: LEGACY_ORCHESTRATOR_GATEWAY_ID,
  workflowManager,
  askManager,
  runtimeInstructionBus,
  moduleRegistry,
  gatewayManager,
  inputLockManager,
  toolRegistry: globalToolRegistry,
  resumableSessionManager,
  wsClients,
  applyOrchestrationConfig,
  getChatCodexRunnerMode: () => (shouldUseMockChatCodexRunner(runtimeFlags) ? 'mock' : 'real'),
  getLoadedAgentConfigDir,
  getLoadedAgentConfigs,
  agentJsonSchema: AGENT_JSON_SCHEMA,
  reloadAgentJsonConfigs,
  wss,
  registry,
  getAgentRuntimeDeps,
  resourcePool,
  runtimeDebug: {
    get: () => runtimeDebugMode,
    set: async (enabled: boolean) => {
      runtimeDebugMode = enabled;
      await ensureDebugRuntimeModules(runtimeDebugMode);
    },
    moduleIds: DEBUG_RUNTIME_MODULE_IDS,
  },
  mockRuntime: {
    rolePolicy: mockRolePolicy,
    clearAssertions: () => mockRuntimeKit.clearMockDispatchAssertions(),
    listAssertions: (filters) => mockRuntimeKit.listMockDispatchAssertions(filters),
  },
  flags: {
    enableFullMockMode: ENABLE_FULL_MOCK_MODE,
    useMockExecutorLoop: USE_MOCK_EXECUTOR_LOOP,
    useMockReviewerLoop: USE_MOCK_REVIEWER_LOOP,
    useMockSearcherLoop: USE_MOCK_SEARCHER_LOOP,
  },
  system: {
    localImageMimeByExt: LOCAL_IMAGE_MIME_BY_EXT,
    listKernelProviders,
    upsertKernelProvider,
    selectKernelProvider,
    testKernelProvider,
  },
});



await ensureSingleInstance(PORT);
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`Finger server running at http://${HOST}:${PORT}`);
  // Initialize OpenClaw gate after server is listening
  initOpenClawGate().catch((err) => {
    console.error('[Server] OpenClaw init error:', err instanceof Error ? err.message : String(err));
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is still in use after cleanup`);
    process.exit(1);
  }
  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});

console.log('[Server] Finger role modules ready:', [
  FINGER_GENERAL_AGENT_ID,
  FINGER_ORCHESTRATOR_AGENT_ID,
  FINGER_RESEARCHER_AGENT_ID,
  FINGER_EXECUTOR_AGENT_ID,
  FINGER_CODER_AGENT_ID,
  FINGER_REVIEWER_AGENT_ID,
].join(', '));
try {
  const loadedOrchestrationConfig = loadOrchestrationConfig();
  const applied = await applyOrchestrationConfig(loadedOrchestrationConfig.config);
  console.log('[Server] Orchestration config applied:', {
    path: loadedOrchestrationConfig.path,
    created: loadedOrchestrationConfig.created,
    appliedAgents: applied.agents,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[Server] Invalid orchestration.json; startup aborted:', message);
  process.exit(1);
}

// =============================================================================
// EventBus 订阅转发到 WebSocket
// =============================================================================

const forwarding = attachEventForwarding({
  eventBus: globalEventBus,
  broadcast,
  sessionManager,
  runtimeInstructionBus,
  inferAgentRoleLabel,
  formatDispatchResultContent,
  asString,
  generalAgentId: FINGER_GENERAL_AGENT_ID,
});
setLoopEventEmitter(forwarding.emitLoopEventToEventBus);
