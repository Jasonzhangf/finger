import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { registry } from '../core/registry.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { RuntimeFacade } from '../runtime/runtime-facade.js';
import { registerDefaultRuntimeTools } from '../runtime/default-tools.js';
import {
  AGENT_JSON_SCHEMA,
  applyAgentJsonConfigs,
  loadAgentJsonConfigs,
  resolveDefaultAgentConfigDir,
  type LoadedAgentConfig,
} from '../runtime/agent-json-config.js';
import { execSync } from 'child_process';
import { createServer } from 'net';
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
  normalizeReviewPolicy,
  saveOrchestrationConfig,
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
  ProcessChatCodexRunner,
  createFingerGeneralModule,
  type ChatCodexLoopEvent,
} from '../agents/finger-general/finger-general-module.js';
import { mailbox } from './mailbox.js';
import { BdTools } from '../agents/shared/bd-tools.js';
import { inputLockManager } from '../runtime/input-lock.js';
import { createWebSocketServer } from './modules/websocket-server.js';
import { createSessionWorkspaceManager } from './modules/session-workspaces.js';
import { attachEventForwarding } from './modules/event-forwarding.js';
import { createMockRuntimeKit, type ChatCodexRunnerController } from './modules/mock-runtime.js';
import { dispatchTaskToAgent as dispatchTaskToAgentModule, registerAgentRuntimeTools } from './modules/agent-runtime/index.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './modules/agent-runtime/types.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerMessageRoutes } from './routes/message.js';
import { registerAgentCliRoutes } from './routes/agent-cli.js';
import { registerAgentRuntimeRoutes } from './routes/agent-runtime.js';
import { registerWorkflowRoutes } from './routes/workflow.js';
import { registerGatewayRoutes } from './routes/gateway.js';
import { registerRuntimeEventRoutes } from './routes/runtime-events.js';
import { registerToolRoutes } from './routes/tools.js';
import { registerResumableSessionRoutes } from './routes/resumable-session.js';
import { setActiveReviewPolicy } from './orchestration/review-policy.js';
import { FINGER_PATHS, ensureDir, ensureFingerLayout } from '../core/finger-paths.js';
import { isObjectRecord } from './common/object.js';
import {
  listKernelProviders,
  resolveActiveKernelProviderId,
  selectKernelProvider,
  testKernelProvider,
  upsertKernelProvider,
} from './provider-config.js';
import {
  TaskBlock,
  AgentBlock,
  EventBusBlock,
  StorageBlock,
  SessionBlock,
  AIBlock,
  ProjectBlock,
  StateBlock,
  OrchestratorBlock,
  WebSocketBlock,
  AgentRuntimeBlock,
} from '../blocks/index.js';

const ERROR_SAMPLE_DIR = FINGER_PATHS.logs.errorsamplesDir;
const BLOCKING_MESSAGE_TIMEOUT_MS = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS))
  ? Math.max(1000, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS)))
  : 600_000;
const BLOCKING_MESSAGE_MAX_RETRIES = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES))
  ? Math.max(0, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES)))
  : 5;
const BLOCKING_MESSAGE_RETRY_BASE_MS = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS))
  ? Math.max(100, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS)))
  : 750;
const PRIMARY_ORCHESTRATOR_AGENT_ID = FINGER_ORCHESTRATOR_AGENT_ID;
const PRIMARY_ORCHESTRATOR_GATEWAY_ID = 'finger-orchestrator-gateway';
const LEGACY_ORCHESTRATOR_AGENT_ID = 'chat-codex';
const LEGACY_ORCHESTRATOR_GATEWAY_ID = 'chat-codex-gateway';
const PRIMARY_ORCHESTRATOR_TARGET = (
  process.env.FINGER_PRIMARY_ORCHESTRATOR_TARGET
  || process.env.VITE_CHAT_PANEL_TARGET
  || PRIMARY_ORCHESTRATOR_GATEWAY_ID
).trim();
const ALLOW_DIRECT_AGENT_ROUTE = process.env.FINGER_ALLOW_DIRECT_AGENT_ROUTE === '1';

function isPrimaryOrchestratorTarget(target: string): boolean {
  const normalized = target.trim();
  if (normalized.length === 0) return false;
  return normalized === PRIMARY_ORCHESTRATOR_TARGET
    || normalized === PRIMARY_ORCHESTRATOR_AGENT_ID
    || normalized === FINGER_GENERAL_AGENT_ID
    || normalized === LEGACY_ORCHESTRATOR_AGENT_ID
    || normalized === PRIMARY_ORCHESTRATOR_GATEWAY_ID
    || normalized === LEGACY_ORCHESTRATOR_GATEWAY_ID;
}

type WebSocketServerRuntime = ReturnType<typeof createWebSocketServer>;
let wsClients: WebSocketServerRuntime['wsClients'];
let wss: WebSocketServerRuntime['wss'];
let broadcast: WebSocketServerRuntime['broadcast'] = () => {};

function resolveBoolFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

const ENABLE_FULL_MOCK_MODE = resolveBoolFlag('FINGER_FULL_MOCK_MODE', false);
const ENABLE_RUNTIME_DEBUG_MODE = resolveBoolFlag('FINGER_RUNTIME_DEBUG_MODE', false);
const ENABLE_LEGACY_CHAT_CODEX_ALIAS = resolveBoolFlag('FINGER_ENABLE_LEGACY_CHAT_CODEX_ALIAS', false);
const ENABLE_MOCK_EXECUTOR = resolveBoolFlag(
  'FINGER_ENABLE_MOCK_EXECUTOR',
  false,
);
const ENABLE_MOCK_REVIEWER = resolveBoolFlag(
  'FINGER_ENABLE_MOCK_REVIEWER',
  false,
);
const ENABLE_MOCK_SEARCHER = resolveBoolFlag(
  'FINGER_ENABLE_MOCK_SEARCHER',
  false,
);
const USE_MOCK_EXECUTOR_LOOP = resolveBoolFlag('FINGER_MOCK_EXECUTOR_LOOP', ENABLE_FULL_MOCK_MODE);
const USE_MOCK_REVIEWER_LOOP = resolveBoolFlag('FINGER_MOCK_REVIEWER_LOOP', ENABLE_FULL_MOCK_MODE);
const USE_MOCK_SEARCHER_LOOP = resolveBoolFlag(
  'FINGER_MOCK_SEARCHER_LOOP',
  true,
);
let runtimeDebugMode = resolveBoolFlag(
  'FINGER_RUNTIME_DEBUG_MODE',
  false,
);

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

function resolveSessionLoopLogPath(sessionId: string): string {
  const dirs = sessionWorkspaceManager.resolveSessionWorkspaceDirsForMessage(sessionId);
  const diagnosticsDir = ensureDir(join(dirs.sessionWorkspaceRoot, 'diagnostics'));
  return join(diagnosticsDir, `${PRIMARY_ORCHESTRATOR_AGENT_ID}.loop.jsonl`);
}

function appendSessionLoopLog(event: ChatCodexLoopEvent): void {
  try {
    const logPath = resolveSessionLoopLogPath(event.sessionId);
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (error) {
    console.error('[Server] append session loop log failed:', error);
  }
}

function writeMessageErrorSample(payload: Record<string, unknown>): void {
  try {
    if (!existsSync(ERROR_SAMPLE_DIR)) {
      mkdirSync(ERROR_SAMPLE_DIR, { recursive: true });
    }
    const now = new Date();
    const fileName = `message-error-${now.toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = join(ERROR_SAMPLE_DIR, fileName);
    const content = {
      timestamp: now.toISOString(),
      localTime: now.toLocaleString(),
      ...payload,
    };
    appendFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf-8');
  } catch (error) {
    console.error('[Server] write message error sample failed:', error);
  }
}

let emitLoopEventToEventBus: (event: ChatCodexLoopEvent) => void = () => {};

function shouldUseMockChatCodexRunner(): boolean {
  return ENABLE_FULL_MOCK_MODE;
}

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE'));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function killProcessOnPort(port: number): void {
  try {
    execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
  } catch {
    // noop
  }
}

async function ensureSingleInstance(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    console.log(`[Server] Port ${port} is in use, killing existing process...`);
    killProcessOnPort(port);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

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

app.get('/api/test', (_req, res) => {
  res.json({ ok: true, message: 'Test route works' });
});

registry.register({ type: 'task', factory: (config) => new TaskBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'agent', factory: (config) => new AgentBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'eventbus', factory: (config) => new EventBusBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'storage', factory: (config) => new StorageBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'session', factory: (config) => new SessionBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'ai', factory: (config) => new AIBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'project', factory: (config) => new ProjectBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'state', factory: (config) => new StateBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'orchestrator', factory: (config) => new OrchestratorBlock(config.id as string), version: '1.0.0' });
registry.register({ type: 'websocket', factory: (config) => new WebSocketBlock(config.id as string), version: '1.0.0' });

registry.createInstance('state', 'state-1');
registry.createInstance('task', 'task-1');
registry.createInstance('agent', 'agent-1');
registry.createInstance('eventbus', 'eventbus-1');
registry.createInstance('storage', 'storage-1');
registry.createInstance('session', 'session-1');
registry.createInstance('ai', 'ai-1');
registry.createInstance('project', 'project-1');
registry.createInstance('orchestrator', 'orchestrator-1');
registry.createInstance('websocket', 'websocket-1');
await registry.initializeAll();

const hub = sharedMessageHub;
const moduleRegistry = new ModuleRegistry(hub);
const sessionManager = sharedSessionManager;
const sessionWorkspaceManager = createSessionWorkspaceManager(sessionManager);
const workflowManager = sharedWorkflowManager;
const runtime = new RuntimeFacade(globalEventBus, sessionManager, globalToolRegistry);
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
let loadedAgentConfigs: LoadedAgentConfig[] = [];
let loadedAgentConfigDir = resolveDefaultAgentConfigDir();

const getAgentRuntimeDeps = (): AgentRuntimeDeps => ({
  agentRuntimeBlock,
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
  ensureOrchestratorRootSession: () => sessionWorkspaceManager.ensureOrchestratorRootSession(),
  ensureRuntimeChildSession: (root, agentId) => sessionWorkspaceManager.ensureRuntimeChildSession(root, agentId),
  isRuntimeChildSession: (session) => sessionWorkspaceManager.isRuntimeChildSession(session),
});

const dispatchTaskToAgent = (input: AgentDispatchRequest) =>
  dispatchTaskToAgentModule(getAgentRuntimeDeps(), input);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function inferAgentRoleLabel(agentId: string): string {
  const normalized = agentId.trim().toLowerCase();
  if (normalized.includes('orchestr')) return 'orchestrator';
  if (normalized.includes('review')) return 'reviewer';
  if (normalized.includes('search')) return 'searcher';
  if (normalized.includes('executor')) return 'executor';
  return 'executor';
}

function formatDispatchResultContent(result: unknown, error?: string): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return `任务失败：${error.trim()}`;
  }
  if (typeof result === 'string') {
    const trimmed = result.trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (isObjectRecord(result)) {
    const response = typeof result.response === 'string' ? result.response.trim() : '';
    if (response.length > 0) return response;
    const output = typeof result.output === 'string' ? result.output.trim() : '';
    if (output.length > 0) return output;
    if (isObjectRecord(result.output) && typeof result.output.response === 'string') {
      const nested = result.output.response.trim();
      if (nested.length > 0) return nested;
    }
  }
  if (result !== undefined) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return error ? `任务失败：${error}` : '任务完成';
}


async function applyOrchestrationConfig(config: OrchestrationConfigV1): Promise<{
  applied: number;
  agents: string[];
  profileId: string;
}> {
  const profile = config.profiles.find((item) => item.id === config.activeProfileId);
  if (!profile) {
    throw new Error(`active orchestration profile not found: ${config.activeProfileId}`);
  }
  setActiveReviewPolicy(normalizeReviewPolicy(profile.reviewPolicy));
  const rootSession = sessionWorkspaceManager.ensureOrchestratorRootSession();
  const appliedAgents: string[] = [];
  const activeAgentIds = new Set(
    profile.agents.filter((item) => item.enabled !== false).map((item) => item.targetAgentId),
  );
  const runtimeView = await agentRuntimeBlock.execute('runtime_view', {}) as {
    agents?: Array<{ id: string; instanceCount?: number }>;
  };
  const currentlyStartedAgentIds = (runtimeView.agents ?? [])
    .filter((item) => (Number.isFinite(item.instanceCount) ? (item.instanceCount as number) > 0 : false))
    .map((item) => item.id);

  for (const staleAgentId of currentlyStartedAgentIds) {
    if (activeAgentIds.has(staleAgentId)) continue;
    const staleSession = sessionWorkspaceManager.findRuntimeChildSession(rootSession.id, staleAgentId);
    await agentRuntimeBlock.execute('deploy', {
      sessionId: staleSession?.id ?? rootSession.id,
      scope: 'session',
      targetAgentId: staleAgentId,
      config: {
        id: staleAgentId,
        name: staleAgentId,
        enabled: false,
      },
    });
  }

  for (const entry of profile.agents) {
    if (entry.enabled === false) continue;
    const targetSessionId = entry.role === 'orchestrator'
      ? rootSession.id
      : sessionWorkspaceManager.ensureRuntimeChildSession(rootSession, entry.targetAgentId).id;
    await agentRuntimeBlock.execute('deploy', {
      sessionId: targetSessionId,
      scope: 'session',
      targetAgentId: entry.targetAgentId,
      ...(typeof entry.targetImplementationId === 'string'
        ? { targetImplementationId: entry.targetImplementationId }
        : {}),
      instanceCount: entry.instanceCount ?? 1,
      launchMode: entry.launchMode ?? (entry.role === 'orchestrator' ? 'orchestrator' : 'manual'),
      config: {
        id: entry.targetAgentId,
        name: entry.targetAgentId,
        role: entry.role,
        enabled: true,
      },
    });
    appliedAgents.push(entry.targetAgentId);
  }
  sessionManager.setCurrentSession(rootSession.id);
  return {
    applied: appliedAgents.length,
    agents: appliedAgents,
    profileId: profile.id,
  };
}

function reloadAgentJsonConfigs(configDir = loadedAgentConfigDir): void {
  const result = loadAgentJsonConfigs(configDir);
  loadedAgentConfigDir = result.dir;
  loadedAgentConfigs = result.loaded;
  applyAgentJsonConfigs(runtime, result.loaded.map((item) => item.config));

  console.log(`[Server] Agent JSON configs loaded: ${result.loaded.length} from ${result.dir}`);
  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`[Server] Agent config load error ${err.filePath}: ${err.error}`);
    }
  }
}

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
  shouldUseMockChatCodexRunner,
);
const resolveFingerToolSpecifications = async (toolNames: string[]) => {
  const resolved: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> = [];
  for (const name of toolNames) {
    const tool = globalToolRegistry.get(name);
    if (!tool || tool.policy !== 'allow') continue;
    resolved.push({
      name: tool.name,
      description: tool.description,
      inputSchema:
        typeof tool.inputSchema === 'object' && tool.inputSchema !== null
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: 'object', additionalProperties: true },
    });
  }
  return resolved;
};

const registerFingerRoleModule = async (
  id: string,
  roleProfile: 'general' | 'orchestrator' | 'researcher' | 'executor' | 'coder' | 'reviewer',
  allowedTools: string[],
): Promise<void> => {
  const roleModule = createFingerGeneralModule({
    id,
    name: id,
    roleProfile,
    resolveToolSpecifications: resolveFingerToolSpecifications,
    toolExecution: {
      daemonUrl: `http://127.0.0.1:${PORT}`,
      agentId: id,
    },
    onLoopEvent: (event) => {
      appendSessionLoopLog(event);
      emitLoopEventToEventBus(event);
    },
  }, chatCodexRunner);
  await moduleRegistry.register(roleModule);
  const policy = runtime.setAgentToolWhitelist(id, allowedTools);
  console.log(`[Server] ${id} module registered, tools=${policy.whitelist.join(', ')}`);
};

await registerFingerRoleModule(FINGER_GENERAL_AGENT_ID, 'general', FINGER_GENERAL_ALLOWED_TOOLS);
await registerFingerRoleModule(FINGER_ORCHESTRATOR_AGENT_ID, 'orchestrator', FINGER_ORCHESTRATOR_ALLOWED_TOOLS);
await registerFingerRoleModule(FINGER_RESEARCHER_AGENT_ID, 'researcher', FINGER_RESEARCHER_ALLOWED_TOOLS);
await registerFingerRoleModule(FINGER_EXECUTOR_AGENT_ID, 'executor', FINGER_EXECUTOR_ALLOWED_TOOLS);
await registerFingerRoleModule(FINGER_CODER_AGENT_ID, 'coder', FINGER_CODER_ALLOWED_TOOLS);
await registerFingerRoleModule(FINGER_REVIEWER_AGENT_ID, 'reviewer', FINGER_REVIEWER_ALLOWED_TOOLS);

if (ENABLE_LEGACY_CHAT_CODEX_ALIAS) {
  const legacyChatCodexAlias = createFingerGeneralModule({
    id: LEGACY_ORCHESTRATOR_AGENT_ID,
    name: LEGACY_ORCHESTRATOR_AGENT_ID,
    roleProfile: 'general',
    resolveToolSpecifications: async (toolNames) => {
      return resolveFingerToolSpecifications(toolNames);
    },
    toolExecution: {
      daemonUrl: `http://127.0.0.1:${PORT}`,
      agentId: LEGACY_ORCHESTRATOR_AGENT_ID,
    },
    onLoopEvent: (event) => {
      appendSessionLoopLog(event);
      emitLoopEventToEventBus(event);
    },
  }, chatCodexRunner);
  await moduleRegistry.register(legacyChatCodexAlias);
  runtime.setAgentToolWhitelist(LEGACY_ORCHESTRATOR_AGENT_ID, FINGER_GENERAL_ALLOWED_TOOLS);
}
console.log(`[Server] Finger runner mode: ${shouldUseMockChatCodexRunner() ? 'mock' : 'real'} (profile/env aware)`);

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
  getLoadedAgentConfigs: () => loadedAgentConfigs,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
});
await agentRuntimeBlock.initialize();
await agentRuntimeBlock.start();
const agentRuntimeTools = registerAgentRuntimeTools(getAgentRuntimeDeps());
console.log(`[Server] Agent runtime tools loaded: ${agentRuntimeTools.join(', ')}`);

const { mockRolePolicy, debugRuntimeModuleIds: DEBUG_RUNTIME_MODULE_IDS } = mockRuntimeKit;
const createMockRuntimeRoleModule = mockRuntimeKit.createMockRuntimeRoleModule;
const ensureDebugRuntimeModules = (enabled: boolean) => mockRuntimeKit.ensureDebugRuntimeModules(enabled, moduleRegistry);

if (ENABLE_MOCK_EXECUTOR) {
  const executorMock = createMockRuntimeRoleModule({
    id: 'executor-mock',
    name: 'Mock Executor',
    role: 'executor',
  });
  await moduleRegistry.register(executorMock);
  console.log('[Server] Mock Executor module registered: executor-mock');
}

if (ENABLE_MOCK_REVIEWER) {
  const reviewerMock = createMockRuntimeRoleModule({
    id: 'reviewer-mock',
    name: 'Mock Reviewer',
    role: 'reviewer',
  });
  await moduleRegistry.register(reviewerMock);
  console.log('[Server] Mock Reviewer module registered: reviewer-mock');
}

if (ENABLE_MOCK_SEARCHER) {
  const searcherMock = createMockRuntimeRoleModule({
    id: 'searcher-mock',
    name: 'Mock Searcher',
    role: 'searcher',
  });
  await moduleRegistry.register(searcherMock);
  console.log('[Server] Mock Searcher module registered: searcher-mock');
}

await ensureDebugRuntimeModules(runtimeDebugMode);

// 加载 autostart agents
await loadAutostartAgents(moduleRegistry).catch(err => {
  console.error('[Server] Failed to load autostart agents:', err);
});

await gatewayManager.start().catch((err) => {
  console.error('[Server] Failed to start gateway manager:', err);
});

moduleRegistry.createRoute(() => true, 'echo-output', {
  blocking: false,
  priority: 0,
  description: 'default route to echo-output'
});
console.log('[Server] Orchestration modules initialized: echo-input, echo-output, finger-general, finger-orchestrator');

registerSystemRoutes(app, {
  registry,
  localImageMimeByExt: LOCAL_IMAGE_MIME_BY_EXT,
  listKernelProviders,
  upsertKernelProvider,
  selectKernelProvider,
  testKernelProvider,
});

app.get('/api/test/:id/state/:key', (req, res) => {
  const block = registry.getBlock(req.params.id);
  if (!block) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }
  const state = block.getState();
  res.json({ [req.params.key]: (state.data as Record<string, unknown>)?.[req.params.key] });
});

app.post('/api/test/:id/state/:key', (req, res) => {
  const block = registry.getBlock(req.params.id);
  if (!block) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }
  res.json({ success: true });
});



// WebSocket server for real-time updates
const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 9998;
({ wss, wsClients, broadcast } = createWebSocketServer({
  port: wsPort,
  serverPort: PORT,
  eventBus: globalEventBus,
  mailbox,
  inputLockManager,
  registerStateBridgeClient: registerWebSocketClient,
  unregisterStateBridgeClient: unregisterWebSocketClient,
}));
// ========== Session Data API ==========
registerSessionRoutes(app, {
  sessionManager,
  runtime,
  eventBus: globalEventBus,
  logsDir: join(process.cwd(), 'logs', 'sessions'),
  resolveSessionLoopLogPath,
});

registerMessageRoutes(app, {
  hub,
  mailbox,
  runtime,
  sessionManager,
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
});

registerAgentCliRoutes(app);

registerWorkflowRoutes(app, {
  workflowManager,
  askManager,
  runtimeInstructionBus,
  broadcast,
  primaryOrchestratorAgentId: PRIMARY_ORCHESTRATOR_AGENT_ID,
});

registerGatewayRoutes(app, {
  hub,
  moduleRegistry,
  gatewayManager,
});

registerRuntimeEventRoutes(app, {
  eventBus: globalEventBus,
  inputLockManager,
  mailbox,
});

registerToolRoutes(app, {
  toolRegistry: globalToolRegistry,
  runtime,
});

registerResumableSessionRoutes(app, {
  resumableSessionManager,
  wsClients,
});

app.get('/api/v1/agents/configs', (_req, res) => {
  res.json({
    success: true,
    dir: loadedAgentConfigDir,
    schema: AGENT_JSON_SCHEMA,
    agents: loadedAgentConfigs.map((item) => ({
      filePath: item.filePath,
      id: item.config.id,
      name: item.config.name,
      role: item.config.role,
      tools: item.config.tools ?? {},
    })),
  });
});

app.get('/api/v1/agents/configs/schema', (_req, res) => {
  res.json({ success: true, schema: AGENT_JSON_SCHEMA });
});

app.post('/api/v1/agents/configs/reload', (req, res) => {
  const requestedDir = req.body?.dir;
  if (requestedDir !== undefined && typeof requestedDir !== 'string') {
    res.status(400).json({ error: 'dir must be string when provided' });
    return;
  }

  try {
    reloadAgentJsonConfigs(requestedDir || loadedAgentConfigDir);
    res.json({
      success: true,
      dir: loadedAgentConfigDir,
      count: loadedAgentConfigs.length,
      agents: loadedAgentConfigs.map((item) => ({
        filePath: item.filePath,
        id: item.config.id,
        role: item.config.role,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});


app.get('/api/v1/orchestration/config', (_req, res) => {
  try {
    const loaded = loadOrchestrationConfig();
    res.json({
      success: true,
      path: loaded.path,
      created: loaded.created,
      config: loaded.config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ success: false, error: message });
  }
});

app.put('/api/v1/orchestration/config', async (req, res) => {
  try {
    const saved = saveOrchestrationConfig(req.body);
    const applied = await applyOrchestrationConfig(saved.config);
    res.json({
      success: true,
      path: saved.path,
      config: saved.config,
      applied,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ success: false, error: message });
  }
});

app.post('/api/v1/orchestration/config/switch', async (req, res) => {
  const body = req.body as { profileId?: unknown };
  const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
  if (!profileId) {
    res.status(400).json({ success: false, error: 'profileId is required' });
    return;
  }
  try {
    const loaded = loadOrchestrationConfig();
    const switched = saveOrchestrationConfig({
      ...loaded.config,
      activeProfileId: profileId,
    });
    const applied = await applyOrchestrationConfig(switched.config);
    res.json({
      success: true,
      path: switched.path,
      config: switched.config,
      applied,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ success: false, error: message });
  }
});

registerAgentRuntimeRoutes(app, {
  getAgentRuntimeDeps,
  moduleRegistry,
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
});

app.get('/api/v1/orchestrator/runtime-mode', (_req, res) => {
  res.json({
    success: true,
    mode: 'finger-general-runner',
    fsmV2Implemented: true,
    runnerModuleId: PRIMARY_ORCHESTRATOR_AGENT_ID,
    chatCodexRunnerMode: shouldUseMockChatCodexRunner() ? 'mock' : 'real',
    updatedAt: new Date().toISOString(),
  });
});

app.post('/api/v1/module/register', async (req, res) => {
  const body = req.body as { filePath?: string };
  if (!body.filePath) {
    res.status(400).json({ error: 'Missing filePath' });
    return;
  }

  try {
    await moduleRegistry.loadFromFile(body.filePath);
    res.json({ success: true, message: `Module loaded from ${body.filePath}` });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: errorMessage });
  }
});

await ensureSingleInstance(PORT);
const server = app.listen(PORT, () => {
  console.log(`Finger server running at http://localhost:${PORT}`);
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
// 性能监控 API
// =============================================================================

import { performanceMonitor } from '../runtime/performance-monitor.js';

app.get('/api/v1/performance', (_req, res) => {
  const metrics = performanceMonitor.getMetrics();
  res.json({
    success: true,
    metrics,
  });
});

app.get('/api/v1/performance/report', (_req, res) => {
  const report = performanceMonitor.generateReport();
  res.type('text/plain').send(report);
});

// 定期发送性能指标到 WebSocket 客户端
setInterval(() => {
  const metrics = performanceMonitor.getMetrics();
  const msg = JSON.stringify({
    type: 'performance_metrics',
    payload: metrics,
    timestamp: new Date().toISOString(),
  });
  
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  }
}, 5000); // 每5秒发送一次

console.log('[Server] Performance monitoring enabled');

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
emitLoopEventToEventBus = forwarding.emitLoopEventToEventBus;

// =============================================================================
// State Bridge 集成
// =============================================================================

import { 
  initializeStateBridge,
  registerWebSocketClient,
  unregisterWebSocketClient,
  getStateSnapshot,
  getAllStateSnapshots,
} from '../orchestration/workflow-state-bridge.js';

// 初始化状态桥接
initializeStateBridge();

// API: 获取工作流状态快照
app.get('/api/v1/workflows/:workflowId/state', (req, res) => {
  const snapshot = getStateSnapshot(req.params.workflowId);
  if (!snapshot) {
    res.status(404).json({ error: 'State snapshot not found' });
    return;
  }
  res.json(snapshot);
});

// API: 获取所有工作流状态快照
app.get('/api/v1/workflows/state', (_req, res) => {
  const snapshots = getAllStateSnapshots();
  res.json({ snapshots });
});

// 注册 WebSocket 客户端
// WebSocket server reference available via wss
wss.on('connection', (ws) => {
  registerWebSocketClient(ws as any);
  
  ws.on('close', () => {
    unregisterWebSocketClient(ws as any);
  });
});

console.log('[Server] State Bridge integration enabled');
