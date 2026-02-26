import express from 'express';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, extname, join } from 'path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs';
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
import { WebSocketServer, type WebSocket } from 'ws';
import { ModuleRegistry } from '../orchestration/module-registry.js';
import { GatewayManager } from '../gateway/gateway-manager.js';
// SessionManager accessed via shared-instances
import { loadAutostartAgents } from '../orchestration/autostart-loader.js';
import { sharedWorkflowManager, sharedMessageHub, sharedSessionManager } from '../orchestration/shared-instances.js';
import { runtimeInstructionBus } from '../orchestration/runtime-instruction-bus.js';
import { resourcePool } from '../orchestration/resource-pool.js';
import { resumableSessionManager } from '../orchestration/resumable-session.js';
import { echoInput, echoOutput } from '../agents/test/mock-echo-agent.js';
import {
  CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS,
  createChatCodexModule,
  type ChatCodexLoopEvent,
} from '../agents/chat-codex/chat-codex-module.js';
import { createRealOrchestratorModule } from '../agents/daemon/orchestrator-module.js';
import { createOrchestratorLoop } from '../agents/daemon/orchestrator-loop.js';
import { createExecutorLoop } from '../agents/daemon/executor-loop.js';
import { mailbox } from './mailbox.js';
import type { OutputModule } from '../orchestration/module-registry.js';
import type { Attachment } from '../runtime/events.js';
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
  WebSocketBlock
} from '../blocks/index.js';

const FINGER_HOME = join(homedir(), '.finger');
const BLOCKING_MESSAGE_TIMEOUT_MS = 300000;

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

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\\/g, '/').replace(/[/:]/g, '_');
}

function resolveSessionLoopLogPath(sessionId: string): string {
  const session = sessionManager.getSession(sessionId);
  const encodedDir = session ? encodeProjectPath(session.projectPath) : '_unknown';
  const dir = join(FINGER_HOME, 'sessions', encodedDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, `${sessionId}.loop.jsonl`);
}

function appendSessionLoopLog(event: ChatCodexLoopEvent): void {
  try {
    const logPath = resolveSessionLoopLogPath(event.sessionId);
    appendFileSync(logPath, `${JSON.stringify(event)}\n`, 'utf-8');
  } catch (error) {
    console.error('[Server] append session loop log failed:', error);
  }
}

function emitLoopEventToEventBus(event: ChatCodexLoopEvent): void {
  if (!event.sessionId || event.sessionId === 'unknown') return;

  if (event.phase === 'turn_error') {
    void globalEventBus.emit({
      type: 'system_error',
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      payload: {
        error: typeof event.payload.error === 'string' ? event.payload.error : 'chat-codex loop error',
        component: 'chat-codex-loop',
        recoverable: true,
      },
    });
    return;
  }
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
const workflowManager = sharedWorkflowManager;
const runtime = new RuntimeFacade(globalEventBus, sessionManager, globalToolRegistry);
const loadedTools = registerDefaultRuntimeTools(globalToolRegistry);
console.log(`[Server] Runtime tools loaded: ${loadedTools.join(', ')}`);
const gatewayManager = new GatewayManager(hub, moduleRegistry, {
  daemonUrl: `http://127.0.0.1:${PORT}`,
});
let loadedAgentConfigs: LoadedAgentConfig[] = [];
let loadedAgentConfigDir = resolveDefaultAgentConfigDir();

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
await moduleRegistry.register(echoInput);
await moduleRegistry.register(echoOutput);
const chatCodexModule = createChatCodexModule({
  resolveToolSpecifications: async (toolNames) => {
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
  },
  toolExecution: {
    daemonUrl: `http://127.0.0.1:${PORT}`,
    agentId: 'chat-codex',
  },
  onLoopEvent: (event) => {
    appendSessionLoopLog(event);
    emitLoopEventToEventBus(event);
  },
});
await moduleRegistry.register(chatCodexModule);
console.log('[Server] Chat Codex module registered: chat-codex');
const chatCodexPolicy = runtime.setAgentToolWhitelist('chat-codex', CHAT_CODEX_CODING_CLI_ALLOWED_TOOLS);
console.log('[Server] Chat Codex tool whitelist applied:', chatCodexPolicy.whitelist.join(', '));

 // 注册真正的编排者 - 集成 iFlow SDK + bd 任务管理
 const { module: realOrchestrator } = createRealOrchestratorModule({
   id: 'orchestrator-1',
   name: 'Real Orchestrator',
   mode: 'auto',
   systemPrompt: '你是一个任务编排专家。请将用户任务拆解为可执行的子任务，并以JSON格式返回。',
 }, hub);
 await realOrchestrator.initialize?.(hub);
 await moduleRegistry.register(realOrchestrator);
 console.log('[Server] Real Orchestrator module registered: orchestrator-1');

// 注册 mock 执行者
const executorMock: OutputModule = {
   id: 'executor-mock',
   type: 'output',
   name: 'Mock Executor',
   version: '1.0.0',
   handle: async (message: any, callback) => {
     const task = message.task || message;
     console.log('[MockExecutor] executing task:', task.description || task);
     const result = {
       taskId: task.taskId || message.taskId,
       success: true,
       output: `执行完成：${task.description || JSON.stringify(task)}`,
     };
     if (callback) callback(result);
     return result;
   },
 };
 await moduleRegistry.register(executorMock);
 console.log('[Server] Mock Executor module registered: executor-mock');

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
console.log('[Server] Orchestration modules initialized: echo-input, echo-output, chat-codex, orchestrator-1, executor-mock');

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/v1/files/local-image', (req, res) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path.trim() : '';
  if (rawPath.length === 0) {
    res.status(400).json({ error: 'query.path is required' });
    return;
  }

  const mimeType = LOCAL_IMAGE_MIME_BY_EXT[extname(rawPath).toLowerCase()];
  if (!mimeType) {
    res.status(415).json({ error: 'unsupported image extension' });
    return;
  }

  const stat = statSync(rawPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    res.status(404).json({ error: 'file not found' });
    return;
  }

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.sendFile(rawPath, (error) => {
    if (!error || res.headersSent) return;
    res.status(500).json({ error: `failed to read image: ${error.message}` });
  });
});

app.get('/api/blocks', (_req, res) => {
  res.json(registry.generateApiEndpoints());
});

app.get('/api/blocks/:id/state', (req, res) => {
  const block = registry.getBlock(req.params.id);
  if (!block) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }
  res.json(block.getState());
});

app.post('/api/blocks/:id/:command', async (req, res) => {
  const { id, command } = req.params;
  const block = registry.getBlock(id);
  if (!block) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }
  try {
    const result = await registry.execute(id, command, req.body.args || {});
    res.json({ success: true, result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

app.get('/api/v1/modules', (_req, res) => {
  res.json({
    inputs: hub.getInputs().map((i) => ({ id: i.id, routes: i.routes })),
    outputs: hub.getOutputs().map((o) => ({ id: o.id })),
    modules: moduleRegistry.getAllModules().map((m) => ({ id: m.id, type: m.type, name: m.name }))
  });
});

app.get('/api/v1/routes', (_req, res) => {
  res.json({ routes: hub.getRoutes() });
});

app.get('/api/v1/gateways', (_req, res) => {
  res.json({
    success: true,
    gateways: gatewayManager.list(),
  });
});

app.get('/api/v1/gateways/:id', (req, res) => {
  const gateway = gatewayManager.inspect(req.params.id);
  if (!gateway) {
    res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
    return;
  }

  res.json({
    success: true,
    gateway: {
      ...gateway.manifest,
      modulePath: gateway.modulePath,
      moduleDir: gateway.moduleDir,
      readmePath: gateway.readmePath,
      cliDocPath: gateway.cliDocPath,
      readmeExcerpt: gateway.readmeExcerpt,
      cliDocExcerpt: gateway.cliDocExcerpt,
    },
  });
});

app.get('/api/v1/gateways/:id/probe', (req, res) => {
  const probe = gatewayManager.probe(req.params.id);
  if (!probe) {
    res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
    return;
  }
  res.json({ success: true, probe });
});

app.post('/api/v1/gateways/register', async (req, res) => {
  const gatewayPath = req.body?.path;
  if (typeof gatewayPath !== 'string' || gatewayPath.trim().length === 0) {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  try {
    const installed = await gatewayManager.registerFromPath(gatewayPath);
    res.json({
      success: true,
      gateway: {
        id: installed.manifest.id,
        modulePath: installed.modulePath,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

app.post('/api/v1/gateways/reload', async (_req, res) => {
  try {
    await gatewayManager.reload();
    res.json({ success: true, gateways: gatewayManager.list() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

app.delete('/api/v1/gateways/:id', async (req, res) => {
  try {
    const removed = await gatewayManager.unregister(req.params.id);
    if (!removed) {
      res.status(404).json({ error: `Gateway not found: ${req.params.id}` });
      return;
    }
    res.json({ success: true, id: req.params.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

app.post('/api/v1/gateways/:id/input', async (req, res) => {
  const body = req.body as {
    message?: unknown;
    target?: string;
    blocking?: boolean;
    sender?: string;
  };
  if (body.message === undefined) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const result = await gatewayManager.dispatchInput(req.params.id, {
      message: body.message,
      target: typeof body.target === 'string' ? body.target : undefined,
      sender: typeof body.sender === 'string' ? body.sender : undefined,
      blocking: body.blocking === true,
    });
    res.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

// Event metadata for UI subscriptions (types + groups)
app.get('/api/v1/events/types', (_req, res) => {
  res.json({
    success: true,
    types: globalEventBus.getSupportedTypes(),
  });
});

app.get('/api/v1/events/groups', (_req, res) => {
  res.json({
    success: true,
    groups: globalEventBus.getSupportedGroups(),
  });
});

app.get('/api/v1/events/history', (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const group = typeof req.query.group === 'string' ? req.query.group : undefined;
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
  
  if (type) {
    res.json({ success: true, events: globalEventBus.getHistoryByType(type, limit) });
    return;
  }
  
  if (group) {
    res.json({ success: true, events: globalEventBus.getHistoryByGroup(group as Parameters<typeof globalEventBus.getHistoryByGroup>[0], limit) });
    return;
  }
  
  res.json({ success: true, events: globalEventBus.getHistory(limit) });
});

// Mailbox API
app.get('/api/v1/mailbox', (req, res) => {
  const messages = mailbox.listMessages({
    target: req.query.target as string,
    status: req.query.status as any,
    limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 10,
  });
  res.json({ messages });
});

app.get('/api/v1/mailbox/:id', (req, res) => {
  const msg = mailbox.getMessage(req.params.id);
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json(msg);
});

app.get('/api/v1/mailbox/callback/:callbackId', (req, res) => {
  const msg = mailbox.getMessageByCallbackId(req.params.callbackId);
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  res.json(msg);
});

app.post('/api/v1/mailbox/clear', (_req, res) => {
  mailbox.cleanup();
  res.json({ success: true, message: 'Mailbox cleaned up' });
});

// WebSocket server for real-time updates
const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 9998;
const wss = new WebSocketServer({ port: wsPort });
console.log(`[Server] Starting WebSocket server on port ${wsPort} (PORT=${PORT})`);
const wsClients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
 wsClients.add(ws);
  console.log('[Server] WebSocket client connected, total clients:', wsClients.size);
 globalEventBus.registerWsClient(ws);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe') {
        // 新协议：支持按分组和按类型订阅
        const types = msg.types || msg.events || [];
        const groups = msg.groups || [];

        if (groups.length > 0 || types.length > 0) {
          // 设置客户端过滤
          globalEventBus.setWsClientFilter(ws, { types, groups });

          // 发送确认
          ws.send(JSON.stringify({
            type: 'subscribe_confirmed',
            types,
            groups,
            timestamp: new Date().toISOString(),
          }));
        } else if (msg.messageId) {
          // Legacy: Subscribe to message updates
          mailbox.subscribe(msg.messageId, (m) => {
            ws.send(JSON.stringify({ type: 'messageUpdate', message: m }));
          });
        }
      } else if (msg.type === 'unsubscribe') {
        // 清除过滤
        globalEventBus.setWsClientFilter(ws, {});
        ws.send(JSON.stringify({ type: 'unsubscribe_confirmed', timestamp: new Date().toISOString() }));
      }
    } catch {
      // ignore
    }
  });
  
  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

 console.log(`[Server] WebSocket server running at ws://localhost:${wsPort}`);
  // Log actual bound address
  const addresses = wss.address();
  console.log(`[Server] WebSocket server bound to:`, addresses);
 // ========== Session Data API ==========
// Real-time session data from ~/.finger/sessions

const LOGS_SESSIONS_DIR = join(process.cwd(), 'logs', 'sessions');

interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  startTime: string;
  endTime?: string;
  success: boolean;
  iterations: Array<{
    round: number;
    action: string;
    thought?: string;
    params?: Record<string, unknown>;
    observation?: string;
    success: boolean;
    timestamp: string;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
}

async function loadSessionLog(sessionId: string): Promise<SessionLog | null> {
  try {
    const files = await readdir(LOGS_SESSIONS_DIR);
    const sessionFile = files.find(f => f.startsWith(sessionId) || f.includes(sessionId));
    if (!sessionFile) return null;
    
    const content = await readFile(join(LOGS_SESSIONS_DIR, sessionFile), 'utf-8');
    return JSON.parse(content) as SessionLog;
  } catch {
    return null;
  }
}

async function loadAllSessionLogs(): Promise<SessionLog[]> {
  try {
    const files = await readdir(LOGS_SESSIONS_DIR);
    const logs: SessionLog[] = [];
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await readFile(join(LOGS_SESSIONS_DIR, file), 'utf-8');
        logs.push(JSON.parse(content) as SessionLog);
      } catch {
        // skip invalid files
      }
    }
    
    return logs.sort((a, b) => 
      new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );
  } catch {
    return [];
  }
}

// Get current session execution state
app.get('/api/v1/sessions/:sessionId/execution', async (req, res) => {
  const sessionId = req.params.sessionId;
  
  try {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    
    // Load related execution logs
    const logs = await loadAllSessionLogs();
    const relatedLogs = logs.filter(l => l.sessionId?.includes(sessionId) || sessionId.includes(l.sessionId));
    
    res.json({
      success: true,
      session: {
        id: session.id,
        name: session.name,
        projectPath: session.projectPath,
        messages: session.messages,
        activeWorkflows: session.activeWorkflows,
      },
      executionLogs: relatedLogs,
    });
  } catch (e) {
    res.status(404).json({ error: 'Session not found', details: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/v1/sessions/match', (req, res) => {
  const projectPath = req.query.projectPath;
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) {
    res.status(400).json({ error: 'Missing projectPath' });
    return;
  }

  const matched = sessionManager.findSessionsByProjectPath(projectPath);
  res.json(
    matched.map((session) => ({
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastAccessedAt: session.lastAccessedAt,
      messageCount: session.messages.length,
      activeWorkflows: session.activeWorkflows,
    })),
  );
});

// Get all execution logs
app.get('/api/v1/execution-logs', async (_req, res) => {
  const logs = await loadAllSessionLogs();
  res.json({ success: true, logs });
});

// Get specific execution log
app.get('/api/v1/execution-logs/:sessionId', async (req, res) => {
  const log = await loadSessionLog(req.params.sessionId);
  if (!log) {
    res.status(404).json({ error: 'Log not found' });
    return;
  }
  res.json({ success: true, log });
});

// ========== Session Management API ==========
app.get('/api/v1/sessions', (_req, res) => {
  const sessions = sessionManager.listSessions();
  res.json(sessions.map(s => ({
    id: s.id,
    name: s.name,
    projectPath: s.projectPath,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastAccessedAt: s.lastAccessedAt,
    messageCount: s.messages.length,
    activeWorkflows: s.activeWorkflows,
  })));
});

app.get('/api/v1/sessions/current', (_req, res) => {
  const session = sessionManager.getCurrentSession();
  if (!session) {
    res.status(404).json({ error: 'No current session' });
    return;
  }
  res.json({
    id: session.id,
    name: session.name,
    projectPath: session.projectPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
    messageCount: session.messages.length,
    activeWorkflows: session.activeWorkflows,
  });
});

app.post('/api/v1/sessions/current', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) {
    res.status(400).json({ error: 'Missing sessionId' });
    return;
  }
  const success = sessionManager.setCurrentSession(sessionId);
  if (!success) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ success: true });
});

app.post('/api/v1/sessions', (req, res) => {
  const { projectPath, name } = req.body;
  const session = sessionManager.createSession(projectPath || process.cwd(), name);
  res.json({
    id: session.id,
    name: session.name,
    projectPath: session.projectPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
    messageCount: 0,
    activeWorkflows: [],
  });
});

app.get('/api/v1/sessions/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({
    id: session.id,
    name: session.name,
    projectPath: session.projectPath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastAccessedAt: session.lastAccessedAt,
    messageCount: session.messages.length,
    activeWorkflows: session.activeWorkflows,
  });
});

app.patch('/api/v1/sessions/:id', (req, res) => {
  const { name } = req.body as { name?: string };
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'Missing name' });
    return;
  }

  try {
    const session = sessionManager.renameSession(req.params.id, name);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json({
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastAccessedAt: session.lastAccessedAt,
      messageCount: session.messages.length,
      activeWorkflows: session.activeWorkflows,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to rename session' });
  }
});

app.delete('/api/v1/sessions/:id', (req, res) => {
  const success = sessionManager.deleteSession(req.params.id);
  if (!success) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  res.json({ success: true });
});

// Session messages
app.get('/api/v1/sessions/:sessionId/messages', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  const messages = sessionManager.getMessages(req.params.sessionId, limit);
  res.json({ success: true, messages });
});

app.get('/api/v1/sessions/:sessionId/loop-logs', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 200;
  const logPath = resolveSessionLoopLogPath(req.params.sessionId);
  if (!existsSync(logPath)) {
    res.json({ success: true, logs: [] });
    return;
  }

  try {
    const lines = readFileSync(logPath, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const parsed = lines
      .slice(-Math.max(1, limit))
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return { timestamp: new Date().toISOString(), phase: 'parse_error', raw: line };
        }
      });
    res.json({ success: true, logs: parsed });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to read loop logs' });
  }
});

app.post('/api/v1/sessions/:sessionId/messages', async (req, res) => {
  const { content, attachments } = req.body;
  if (!content) {
    res.status(400).json({ error: 'Missing content' });
    return;
  }
  try {
    const result = await runtime.sendMessage(req.params.sessionId, content, attachments);
    res.json({ success: true, messageId: result.messageId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post('/api/v1/sessions/:sessionId/messages/append', (req, res) => {
  const { role, content, attachments } = req.body as {
    role?: 'user' | 'assistant' | 'system' | 'orchestrator';
    content?: string;
    attachments?: unknown;
  };

  if (!role || (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'orchestrator')) {
    res.status(400).json({ error: 'Invalid role' });
    return;
  }
  if (typeof content !== 'string' || content.length === 0) {
    res.status(400).json({ error: 'Missing content' });
    return;
  }

  const message = sessionManager.addMessage(
    req.params.sessionId,
    role,
    content,
    Array.isArray(attachments) ? { attachments: attachments as Attachment[] } : undefined,
  );

  if (!message) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  res.json({ success: true, message });
});

// Session pause/resume
app.post('/api/v1/sessions/:sessionId/pause', (req, res) => {
  const success = sessionManager.pauseSession(req.params.sessionId);
  if (!success) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  globalEventBus.emit({
    type: 'session_paused',
    sessionId: req.params.sessionId,
    timestamp: new Date().toISOString(),
    payload: {},
  });
  res.json({ success: true });
});

app.post('/api/v1/sessions/:sessionId/resume', (req, res) => {
  const success = sessionManager.resumeSession(req.params.sessionId);
  if (!success) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  globalEventBus.emit({
    type: 'session_resumed',
    sessionId: req.params.sessionId,
    timestamp: new Date().toISOString(),
    payload: { messageCount: sessionManager.getMessages(req.params.sessionId).length },
  });
  res.json({ success: true });
});

// Session compress
app.post('/api/v1/sessions/:sessionId/compress', async (req, res) => {
  try {
    const summary = await sessionManager.compressContext(req.params.sessionId);
    const status = sessionManager.getCompressionStatus(req.params.sessionId);
    res.json({ success: true, summary, originalCount: status.originalCount });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Session context
app.get('/api/v1/sessions/:sessionId/context', (req, res) => {
  const context = sessionManager.getFullContext(req.params.sessionId);
  const status = sessionManager.getCompressionStatus(req.params.sessionId);
  res.json({
    success: true,
    messages: context.messages,
    compressedSummary: context.compressedSummary,
    compressed: status.compressed,
    originalCount: status.originalCount,
  });
});

// Tool policy
app.get('/api/v1/tools', (_req, res) => {
  const tools = globalToolRegistry.list();
  res.json({ success: true, tools });
});

app.put('/api/v1/tools/:name/policy', (req, res) => {
  const { policy } = req.body;
  if (policy !== 'allow' && policy !== 'deny') {
    res.status(400).json({ error: 'Invalid policy. Must be "allow" or "deny"' });
    return;
  }
  const success = globalToolRegistry.setPolicy(req.params.name, policy);
  if (!success) {
    res.status(404).json({ error: 'Tool not found' });
    return;
  }
  res.json({ success: true, name: req.params.name, policy });
});

app.put('/api/v1/tools/:name/authorization', (req, res) => {
  const required = req.body?.required;
  if (typeof required !== 'boolean') {
    res.status(400).json({ error: 'required must be boolean' });
    return;
  }
  runtime.setToolAuthorizationRequired(req.params.name, required);
  res.json({ success: true, name: req.params.name, required });
});

app.post('/api/v1/tools/authorizations', (req, res) => {
  const agentId = req.body?.agentId;
  const toolName = req.body?.toolName;
  const issuedBy = req.body?.issuedBy;
  const ttlMs = req.body?.ttlMs;
  const maxUses = req.body?.maxUses;

  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  if (typeof issuedBy !== 'string' || issuedBy.trim().length === 0) {
    res.status(400).json({ error: 'issuedBy is required' });
    return;
  }

  const grant = runtime.issueToolAuthorization(agentId, toolName, issuedBy, {
    ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined,
    maxUses: typeof maxUses === 'number' ? maxUses : undefined,
  });

  res.json({ success: true, authorization: grant });
});

app.delete('/api/v1/tools/authorizations/:token', (req, res) => {
  const revoked = runtime.revokeToolAuthorization(req.params.token);
  if (!revoked) {
    res.status(404).json({ error: 'authorization token not found' });
    return;
  }
  res.json({ success: true, token: req.params.token });
});

app.post('/api/v1/tools/execute', async (req, res) => {
  const agentId = req.body?.agentId;
  const toolName = req.body?.toolName;
  const input = req.body?.input;
  const authorizationToken = req.body?.authorizationToken;

  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    res.status(400).json({ error: 'agentId is required' });
    return;
  }
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  if (authorizationToken !== undefined && typeof authorizationToken !== 'string') {
    res.status(400).json({ error: 'authorizationToken must be string when provided' });
    return;
  }

  try {
    const result = await runtime.callTool(agentId, toolName, input, { authorizationToken });
    res.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
});

app.post('/api/v1/tools/register', (req, res) => {
  const { name, description, inputSchema, handler, policy } = req.body;
  if (!name || typeof handler !== 'function') {
    res.status(400).json({ error: 'Missing name or handler' });
    return;
  }
  globalToolRegistry.register({
    name,
    description: description || '',
    inputSchema: inputSchema || {},
    policy: policy || 'allow',
    handler,
  });
  res.json({ success: true, name, policy: policy || 'allow' });
});

// Agent tool whitelist / blacklist
app.get('/api/v1/tools/agents/:agentId/policy', (req, res) => {
  const policy = runtime.getAgentToolPolicy(req.params.agentId);
  res.json({ success: true, policy });
});

app.put('/api/v1/tools/agents/:agentId/policy', (req, res) => {
  const whitelistRaw = req.body?.whitelist;
  const blacklistRaw = req.body?.blacklist;

  if (whitelistRaw !== undefined && !Array.isArray(whitelistRaw)) {
    res.status(400).json({ error: 'whitelist must be string[]' });
    return;
  }
  if (blacklistRaw !== undefined && !Array.isArray(blacklistRaw)) {
    res.status(400).json({ error: 'blacklist must be string[]' });
    return;
  }

  const whitelist = Array.isArray(whitelistRaw) ? whitelistRaw.filter((item): item is string => typeof item === 'string') : undefined;
  const blacklist = Array.isArray(blacklistRaw) ? blacklistRaw.filter((item): item is string => typeof item === 'string') : undefined;

  if (whitelist) {
    runtime.setAgentToolWhitelist(req.params.agentId, whitelist);
  }
  if (blacklist) {
    runtime.setAgentToolBlacklist(req.params.agentId, blacklist);
  }

  const policy = runtime.getAgentToolPolicy(req.params.agentId);
  res.json({ success: true, policy });
});

app.post('/api/v1/tools/agents/:agentId/grant', (req, res) => {
  const toolName = req.body?.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  const policy = runtime.grantToolToAgent(req.params.agentId, toolName);
  res.json({ success: true, policy });
});

app.post('/api/v1/tools/agents/:agentId/revoke', (req, res) => {
  const toolName = req.body?.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  const policy = runtime.revokeToolFromAgent(req.params.agentId, toolName);
  res.json({ success: true, policy });
});

app.post('/api/v1/tools/agents/:agentId/deny', (req, res) => {
  const toolName = req.body?.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  const policy = runtime.denyToolForAgent(req.params.agentId, toolName);
  res.json({ success: true, policy });
});

app.post('/api/v1/tools/agents/:agentId/allow', (req, res) => {
  const toolName = req.body?.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    res.status(400).json({ error: 'toolName is required' });
    return;
  }
  const policy = runtime.allowToolForAgent(req.params.agentId, toolName);
  res.json({ success: true, policy });
});

app.get('/api/v1/tools/agents/presets', (_req, res) => {
  res.json({ success: true, presets: runtime.listRoleToolPolicyPresets() });
});

app.post('/api/v1/tools/agents/:agentId/role-policy', (req, res) => {
  const role = req.body?.role;
  if (typeof role !== 'string' || role.trim().length === 0) {
    res.status(400).json({ error: 'role is required' });
    return;
  }

  try {
    const policy = runtime.applyAgentRoleToolPolicy(req.params.agentId, role);
    res.json({ success: true, role, policy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: message });
  }
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

// ========== Workflow Management API ==========
app.get('/api/v1/workflows', (_req, res) => {
  const workflows = workflowManager.listWorkflows();
  res.json(workflows.map(w => ({
    id: w.id,
    sessionId: w.sessionId,
    epicId: w.epicId,
    status: w.status,
    taskCount: w.tasks.size,
    completedTasks: Array.from(w.tasks.values()).filter(t => t.status === 'completed').length,
    failedTasks: Array.from(w.tasks.values()).filter(t => t.status === 'failed').length,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
    userTask: w.userTask,
  })));
});

app.get('/api/v1/workflows/:id', (req, res) => {
  const workflow = workflowManager.getWorkflow(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  const tasks = Array.from(workflow.tasks.values());
  res.json({
    id: workflow.id,
    sessionId: workflow.sessionId,
    epicId: workflow.epicId,
    status: workflow.status,
    taskCount: workflow.tasks.size,
    completedTasks: tasks.filter(t => t.status === 'completed').length,
    failedTasks: tasks.filter(t => t.status === 'failed').length,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    userTask: workflow.userTask,
  });
});

app.get('/api/v1/workflows/:id/tasks', (req, res) => {
  const workflow = workflowManager.getWorkflow(req.params.id);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  const tasks = Array.from(workflow.tasks.values());
  res.json(tasks);
});

app.post('/api/v1/workflow/pause', async (req, res) => {
  const { workflowId, hard } = req.body;
  if (!workflowId) {
    res.status(400).json({ error: 'Missing workflowId' });
    return;
  }
  const workflow = workflowManager.getWorkflow(workflowId);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  workflowManager.pauseWorkflow(workflowId, hard);
  
  // Broadcast pause to WebSocket clients
  const broadcastMsg = JSON.stringify({
    type: 'workflow_update',
    payload: { workflowId, status: 'paused' },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, workflowId, status: 'paused' });
});

app.post('/api/v1/workflow/resume', async (req, res) => {
  const { workflowId } = req.body;
  if (!workflowId) {
    res.status(400).json({ error: 'Missing workflowId' });
    return;
  }
  const workflow = workflowManager.getWorkflow(workflowId);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  workflowManager.resumeWorkflow(workflowId);
  
  // Broadcast resume to WebSocket clients
  const broadcastMsg = JSON.stringify({
    type: 'workflow_update',
    payload: { workflowId, status: 'executing' },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, workflowId, status: 'executing' });
});

app.post('/api/v1/workflow/input', async (req, res) => {
  const { workflowId, input } = req.body;
  if (!workflowId || !input) {
    res.status(400).json({ error: 'Missing workflowId or input' });
    return;
  }
  const workflow = workflowManager.getWorkflow(workflowId);
  if (!workflow) {
    res.status(404).json({ error: 'Workflow not found' });
    return;
  }
  
  // Store user input in workflow context and route runtime instruction to loop parser.
  workflowManager.updateWorkflowContext(workflowId, { lastUserInput: input });
  runtimeInstructionBus.push(workflowId, String(input));

  const workflowEpicId = workflow.epicId;
  if (workflowEpicId) {
    runtimeInstructionBus.push(workflowEpicId, String(input));
  }
  
  // Broadcast input to WebSocket clients
  const broadcastMsg = JSON.stringify({
    type: 'workflow_update',
    payload: { workflowId, userInput: input },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, workflowId });
});

// ========== Agent Deployment API ==========
interface AgentDeployment {
  id: string;
  config: Record<string, unknown>;
  sessionId: string;
  scope: 'session' | 'global';
  instanceCount: number;
  status: 'idle' | 'running' | 'error';
  createdAt: string;
}

const agentDeployments: Map<string, AgentDeployment> = new Map();

app.get('/api/v1/agents', (_req, res) => {
  // Return resource pool view (single process per agent)
  const resources = resourcePool.getAllResources();
  res.json(resources.map(r => ({
    id: r.id,
    type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor',
    name: r.name || r.id,
    status: r.status,
    sessionId: r.currentSessionId,
    workflowId: r.currentWorkflowId,
    totalDeployments: r.totalDeployments,
  })));
});

// Resource pool: get available resources
app.get('/api/v1/resources', (_req, res) => {
  const available = resourcePool.getAvailableResources();
  res.json({
    available: available.map(r => ({
      id: r.id,
      name: r.name || r.id,
      type: r.id.includes('orchestrator') ? 'orchestrator' : 'executor',
      status: r.status,
    })),
    count: available.length,
  });
});

// Resource pool: deploy resource to session
app.post('/api/v1/resources/deploy', (req, res) => {
  const { resourceId, sessionId, workflowId } = req.body;
  if (!resourceId || !sessionId || !workflowId) {
    res.status(400).json({ error: 'Missing resourceId, sessionId, or workflowId' });
    return;
  }
  
  resourcePool.deployResource(resourceId, sessionId, workflowId);
  const resource = resourcePool.getAllResources().find(r => r.id === resourceId);
  if (!resource) {
    res.status(409).json({ error: 'Resource not available or already deployed' });
    return;
  }
  
  // Broadcast to WebSocket
  const broadcastMsg = JSON.stringify({
    type: 'resource_update',
    payload: {
      resourceId,
      status: resource.status,
      sessionId,
      workflowId,
    },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, resource });
});

// Resource pool: release resource back to pool
app.post('/api/v1/resources/release', (req, res) => {
  const { resourceId } = req.body;
  if (!resourceId) {
    res.status(400).json({ error: 'Missing resourceId' });
    return;
  }
  
  resourcePool.releaseResource(resourceId);
  const resource = resourcePool.getAllResources().find(r => r.id === resourceId);
  if (!resource) {
    res.status(404).json({ error: 'Resource not found' });
    return;
  }
  
  // Broadcast to WebSocket
  const broadcastMsg = JSON.stringify({
    type: 'resource_update',
    payload: {
      resourceId,
      status: resource.status,
    },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, resource });
});

// Session: create checkpoint
app.post('/api/v1/session/checkpoint', (req, res) => {
  const { sessionId, originalTask, taskProgress, agentStates, context } = req.body;
  if (!sessionId || !originalTask || !taskProgress) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }
  
  const checkpoint = resumableSessionManager.createCheckpoint(
    sessionId,
    originalTask,
    taskProgress,
    agentStates || {},
    context || {}
  );
  
  res.json({ success: true, checkpointId: checkpoint.checkpointId });
});

// Session: load checkpoint
app.get('/api/v1/session/checkpoint/:checkpointId', (req, res) => {
  const checkpoint = resumableSessionManager.loadCheckpoint(req.params.checkpointId);
  if (!checkpoint) {
    res.status(404).json({ error: 'Checkpoint not found' });
    return;
  }
  res.json(checkpoint);
});

// Session: find latest checkpoint
app.get('/api/v1/session/:sessionId/checkpoint/latest', (req, res) => {
  const checkpoint = resumableSessionManager.findLatestCheckpoint(req.params.sessionId);
  if (!checkpoint) {
    res.status(404).json({ error: 'No checkpoint found for session' });
    return;
  }
  
  const resumeContext = resumableSessionManager.buildResumeContext(checkpoint);
  res.json({
    checkpoint,
    resumeContext,
  });
});

// Session: resume with context
app.post('/api/v1/session/resume', (req, res) => {
  const { sessionId, checkpointId } = req.body;
  
  let checkpoint: ReturnType<typeof resumableSessionManager.loadCheckpoint>;
  
  if (checkpointId) {
    checkpoint = resumableSessionManager.loadCheckpoint(checkpointId);
  } else {
    checkpoint = resumableSessionManager.findLatestCheckpoint(sessionId);
  }
  
  if (!checkpoint) {
    res.status(404).json({ error: 'Checkpoint not found' });
    return;
  }
  
  const resumeContext = resumableSessionManager.buildResumeContext(checkpoint);
  
  // Broadcast resume event
  const broadcastMsg = JSON.stringify({
    type: 'session_resume',
    payload: {
      sessionId: checkpoint.sessionId,
      checkpointId: checkpoint.checkpointId,
      progress: resumeContext.estimatedProgress,
      pendingTasks: checkpoint.pendingTaskIds.length,
    },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({
    success: true,
    sessionId: checkpoint.sessionId,
    resumeContext,
  });
});

// Agent progress: get detailed progress
app.get('/api/v1/agent/:agentId/progress', (req, res) => {
  const resource = resourcePool.getAllResources().find(r => r.id === req.params.agentId);
  if (!resource) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  
  // Get execution logs for this agent
  const executionLogPath = join(FINGER_HOME, 'logs', `${req.params.agentId}.jsonl`);
  let iterations: unknown[] = [];
  
  try {
    if (existsSync(executionLogPath)) {
      const content = readFileSync(executionLogPath, 'utf-8');
      iterations = content
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line))
        .slice(-50); // Last 50 iterations
    }
  } catch {
    // Ignore errors
  }
  
  res.json({
    agentId: resource.id,
    status: resource.status,
    sessionId: resource.currentSessionId,
    workflowId: resource.currentWorkflowId,
    totalDeployments: resource.totalDeployments,
    iterations,
    lastDeployedAt: resource.deployedAt,
  });
});

app.post('/api/v1/agents/deploy', async (req, res) => {
  const { sessionId, config, scope, instanceCount = 1 } = req.body;
  if (!config || !config.name) {
    res.status(400).json({ error: 'Missing agent config' });
    return;
  }
  
  const deploymentId = `deployment-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const deployment: AgentDeployment = {
    id: deploymentId,
    config,
    sessionId: sessionId || 'default',
    scope: scope || 'session',
    instanceCount,
    status: 'idle',
    createdAt: new Date().toISOString(),
  };
  
  agentDeployments.set(deploymentId, deployment);
  
  // Broadcast deployment to WebSocket clients
  const broadcastMsg = JSON.stringify({
    type: 'agent_update',
    payload: {
      agentId: deploymentId,
      status: 'idle',
      config,
      instanceCount,
    },
    timestamp: new Date().toISOString(),
  });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }
  
  res.json({ success: true, deploymentId, deployment });
});

app.get('/api/v1/agents/stats', (_req, res) => {
  const stats = Array.from(agentDeployments.values()).map(d => ({
    id: d.id,
    name: d.config.name as string,
    type: 'executor' as const,
    status: d.status,
    load: 0,
    errorRate: 0,
    requestCount: 0,
    tokenUsage: 0,
    workTime: 0,
  }));
  res.json(stats);
});

app.get('/api/v1/agents/:id/stats', (req, res) => {
  const deployment = agentDeployments.get(req.params.id);
  if (!deployment) {
    res.status(404).json({ error: 'Agent deployment not found' });
    return;
  }
  res.json({
    id: deployment.id,
    name: deployment.config.name,
    type: 'executor' as const,
    status: deployment.status,
    load: 0,
    errorRate: 0,
    requestCount: 0,
    tokenUsage: 0,
    workTime: 0,
  });
});

// Modified message endpoint with mailbox integration
app.post('/api/v1/message', async (req, res) => {
  const body = req.body as { target?: string; message?: unknown; blocking?: boolean; sender?: string; callbackId?: string };
  if (!body.target || body.message === undefined) {
    res.status(400).json({ error: 'Missing target or message' });
    return;
  }

  // Create mailbox message for tracking
  const messageId = mailbox.createMessage(body.target, body.message, body.sender, body.callbackId);
  mailbox.updateStatus(messageId, 'processing');

  // Broadcast to WebSocket clients
  const broadcastMsg = JSON.stringify({ type: 'messageCreated', messageId, status: 'processing' });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }

  try {
    if (body.blocking) {
      let primaryResult: unknown;
      let senderResponse: unknown | undefined;

      // Send the message to the target module and await its direct return
      try {
        primaryResult = await Promise.race([
          hub.sendToModule(body.target, body.message),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`Timed out waiting for module response: ${body.target}`)), BLOCKING_MESSAGE_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const statusCode = errorMessage.includes('Timed out') ? 504 : 400;
        mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
        res.status(statusCode).json({ messageId, status: 'failed', error: errorMessage });
        return;
      }

      if (primaryResult === undefined) {
        const errorMessage = `No result returned from module: ${body.target}`;
        mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
        res.status(502).json({ messageId, status: 'failed', error: errorMessage });
        return;
      }
      
      // If a sender is specified, attempt to route the primary result back to the sender module
      if (body.sender) {
        try {
          senderResponse = await hub.sendToModule(body.sender, { 
            type: 'callback', 
            payload: primaryResult, 
            originalMessageId: messageId 
          });
          console.log('[Server] Callback result sent to sender', body.sender, 'Response:', senderResponse);
        } catch (err) {
          console.error('[Server] Failed to route callback result to sender', body.sender, err);
        }
      }

      const actualResult = primaryResult;
      mailbox.updateStatus(messageId, 'completed', actualResult);
      
      // Broadcast completion
      const completeBroadcast = JSON.stringify({ type: 'messageCompleted', messageId, result: actualResult, callbackResult: senderResponse });
      for (const client of wsClients) {
        if (client.readyState === 1) client.send(completeBroadcast);
      }
      
      res.json({ messageId, status: 'completed', result: actualResult, callbackResult: senderResponse });
      return;
    }

    // Non-blocking: return messageId immediately
    hub.sendToModule(body.target, body.message, body.sender ? (result: any) => {
        hub.sendToModule(body.sender!, { type: 'callback', payload: result, originalMessageId: messageId })
          .catch(() => { /* Ignore sender callback errors */ });
        return result;
      } : undefined)
      .then((result) => {
        mailbox.updateStatus(messageId, 'completed', result);
        const completeBroadcast = JSON.stringify({ type: 'messageCompleted', messageId, result });
        for (const client of wsClients) {
          if (client.readyState === 1) client.send(completeBroadcast);
        }
      })
      .catch((err) => {
        console.error('[Hub] Send error:', err);
        mailbox.updateStatus(messageId, 'failed', undefined, err.message);
      });
    
    res.json({ messageId, status: 'queued' });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
    res.status(400).json({ messageId, status: 'failed', error: errorMessage });
  }
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

// 注册 ReACT 循环版本的编排者和执行者
const { module: orchestratorLoop } = createOrchestratorLoop({
  id: 'orchestrator-loop',
  name: 'Orchestrator ReACT Loop',
  mode: 'auto',
  cwd: process.cwd(),
  maxRounds: 10,
}, hub);
await orchestratorLoop.initialize?.(hub);
await moduleRegistry.register(orchestratorLoop);
console.log('[Server] OrchestratorLoop module registered: orchestrator-loop');

const { module: executorLoop } = createExecutorLoop({
  id: 'executor-loop',
  name: 'Executor ReACT Loop',
  mode: 'auto',
  cwd: process.cwd(),
  maxIterations: 5,
});
await moduleRegistry.register(executorLoop);
console.log('[Server] ExecutorLoop module registered: executor-loop');

console.log('[Server] ReACT Loop modules ready: orchestrator-loop, executor-loop');

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

globalEventBus.subscribeMultiple(
  ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
  (event) => {
    // 将 EventBus 事件转换为前端理解的 workflow_update 格式
    const wsMsg = {
      type: 'workflow_update',
      payload: {
        workflowId: event.sessionId,
        taskId: (event.payload as any)?.taskId,
        status: event.type === 'task_completed' ? 'completed' : event.type === 'task_failed' ? 'failed' : 'executing',
        orchestratorState: event.type === 'phase_transition' ? { round: (event.payload as any)?.round } : undefined,
        taskUpdates: event.type === 'task_started' || event.type === 'task_completed' || event.type === 'task_failed' ? [{
          id: (event.payload as any)?.taskId,
          status: event.type === 'task_started' ? 'in_progress' : event.type === 'task_completed' ? 'completed' : 'failed',
        }] : undefined,
      },
      timestamp: event.timestamp,
    };
    
    const msg = JSON.stringify(wsMsg);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }
);

console.log('[Server] EventBus subscription enabled: task_started, task_completed, task_failed, workflow_progress, phase_transition');

// 转发 agent 执行事件到前端，确保对话面板可以看到 thought/action/observation
// 使用 runtime-facade 和 orchestrator-loop 中实际使用的事件类型
globalEventBus.subscribeMultiple(
  ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
  (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    const taskDetails = payload?.task || payload?.result;

    // 当任务完成或失败时，将详细的 thought/action/observation 转发给前端
    const wsMsg = {
      type: 'agent_update',
      payload: {
        agentId: (payload?.agentId as string | undefined) || event.sessionId,
        status: event.type === 'task_completed' ? 'idle' : event.type === 'task_failed' ? 'error' : 'running',
        currentTaskId: payload?.taskId as string | undefined,
        load: ((payload?.progress as number | undefined) ?? 0),
        step: {
          round: (payload?.round as number | undefined) ?? 1,
          thought: (taskDetails as any)?.thought,
          action: (taskDetails as any)?.action,
          observation: (taskDetails as any)?.observation || (taskDetails as any)?.result,
          success: event.type !== 'task_failed',
          timestamp: event.timestamp,
        },
      },
      timestamp: event.timestamp,
    };

    const msg = JSON.stringify(wsMsg);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }
);

globalEventBus.subscribeMultiple(
  ['task_started', 'task_completed', 'task_failed', 'workflow_progress', 'phase_transition'],
  (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    const step = (payload?.step as Record<string, unknown> | undefined) ?? {};

    const wsMsg = {
      type: 'agent_update',
      payload: {
        agentId: (payload?.agentId as string | undefined) || event.sessionId,
        status: (payload?.status as string | undefined) || 'running',
        currentTaskId: payload?.taskId as string | undefined,
        load: ((payload?.load as number | undefined) ?? (payload?.progress as number | undefined) ?? 0),
        step: {
          round: ((payload?.round as number | undefined) ?? (step.round as number | undefined) ?? 1),
          action: (payload?.action as string | undefined) || (step.action as string | undefined),
          thought: (payload?.thought as string | undefined) || (step.thought as string | undefined),
          observation: (payload?.observation as string | undefined) || (step.observation as string | undefined),
          params: (payload?.params as Record<string, unknown> | undefined) || (step.params as Record<string, unknown> | undefined),
          success: (payload?.success as boolean | undefined) !== false,
          timestamp: event.timestamp,
        },
      },
      timestamp: event.timestamp,
    };

    const msg = JSON.stringify(wsMsg);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }
);

console.log('[Server] EventBus agent forwarding enabled: agent_thought, agent_action, agent_observation, agent_step_completed');

// 新增：监听 agent_step_completed 事件（从 react-loop.ts 发出），包含详细 thought/action/observation
globalEventBus.subscribe(
  'agent_step_completed',
  (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;

    // 将 agent_step_completed 转换为前端理解的 agent_update 格式
    const wsMsg = {
      type: 'agent_update',
      payload: {
        agentId: ('agentId' in event ? (event as { agentId?: string }).agentId : undefined) || event.sessionId,
        status: (payload?.success as boolean) !== false ? 'running' : 'error',
        currentTaskId: payload?.taskId as string | undefined,
        load: 50,
        step: {
          round: (payload?.round as number | undefined) ?? 1,
          thought: payload?.thought as string | undefined,
          action: payload?.action as string | undefined,
          observation: payload?.observation as string | undefined,
          success: (payload?.success as boolean | undefined) !== false,
          timestamp: event.timestamp,
        },
      },
      timestamp: event.timestamp,
    };

    const msg = JSON.stringify(wsMsg);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(msg);
      }
    }
  }
);

console.log('[Server] EventBus agent_step_completed forwarding enabled for detailed agent updates');

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

// =============================================================================
// Agent CLI API - UI 调用入口
// =============================================================================

// API: 语义理解
app.post('/api/v1/agent/understand', async (req, res) => {
  const { input, sessionId } = req.body;
  if (!input) {
    res.status(400).json({ error: 'Missing input' });
    return;
  }

  try {
    // 调用 Understanding Agent
    const result = await understandCommand(input, { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 路由决策
app.post('/api/v1/agent/route', async (req, res) => {
  const { intentAnalysis, sessionId } = req.body;
  if (!intentAnalysis) {
    res.status(400).json({ error: 'Missing intentAnalysis' });
    return;
  }

  try {
    const result = await routeCommand(JSON.stringify(intentAnalysis), { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 任务规划
app.post('/api/v1/agent/plan', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    const result = await planCommand(task, { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 任务执行
app.post('/api/v1/agent/execute', async (req, res) => {
  const { task, agent, blocking, sessionId } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    const result = await executeCommand(task, { agent, blocking, sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 质量审查
app.post('/api/v1/agent/review', async (req, res) => {
  const { proposal } = req.body;
  if (!proposal) {
    res.status(400).json({ error: 'Missing proposal' });
    return;
  }

  try {
    const result = await reviewCommand(JSON.stringify(proposal));
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 编排协调
app.post('/api/v1/agent/orchestrate', async (req, res) => {
  const { task, sessionId, watch } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    // 如果 watch=true，通过 WebSocket 推送进度
    if (watch) {
      await orchestrateCommand(task, { sessionId, watch: true });
      res.json({ success: true, message: 'Orchestration started, streaming via WebSocket' });
    } else {
      const result = await orchestrateCommand(task, { sessionId });
      res.json({ success: true, result });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 触发状态转换
app.post('/api/v1/workflow/:workflowId/transition', async (req, res) => {
  const { workflowId } = req.params;
  const { trigger, context } = req.body;
  
  if (!trigger) {
    res.status(400).json({ error: 'Missing trigger' });
    return;
  }

  try {
    const fsm = getOrCreateWorkflowFSM({
      workflowId,
      sessionId: req.body.sessionId || workflowId,
    });

    const success = await fsm.trigger(trigger as any, context);
    
    if (!success) {
      res.status(400).json({ error: 'Transition failed', trigger, currentState: fsm.getState() });
      return;
    }

    res.json({
      success: true,
      currentState: fsm.getState(),
      context: fsm.getContext(),
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

console.log('[Server] Agent CLI API enabled');

// =============================================================================
// Agent CLI API - UI 调用入口
// =============================================================================

import {
  understandCommand,
  routeCommand,
  planCommand,
  executeCommand,
  reviewCommand,
  orchestrateCommand,
} from '../cli/agent-commands.js';
import { getOrCreateWorkflowFSM } from '../orchestration/workflow-fsm.js';

// API: 语义理解
app.post('/api/v1/agent/understand', async (req, res) => {
  const { input, sessionId } = req.body;
  if (!input) {
    res.status(400).json({ error: 'Missing input' });
    return;
  }

  try {
    const result = await understandCommand(input, { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 路由决策
app.post('/api/v1/agent/route', async (req, res) => {
  const { intentAnalysis, sessionId } = req.body;
  if (!intentAnalysis) {
    res.status(400).json({ error: 'Missing intentAnalysis' });
    return;
  }

  try {
    const result = await routeCommand(JSON.stringify(intentAnalysis), { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 任务规划
app.post('/api/v1/agent/plan', async (req, res) => {
  const { task, sessionId } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    const result = await planCommand(task, { sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 任务执行
app.post('/api/v1/agent/execute', async (req, res) => {
  const { task, agent, blocking, sessionId } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    const result = await executeCommand(task, { agent, blocking, sessionId });
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 质量审查
app.post('/api/v1/agent/review', async (req, res) => {
  const { proposal } = req.body;
  if (!proposal) {
    res.status(400).json({ error: 'Missing proposal' });
    return;
  }

  try {
    const result = await reviewCommand(JSON.stringify(proposal));
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 编排协调
app.post('/api/v1/agent/orchestrate', async (req, res) => {
  const { task, sessionId, watch } = req.body;
  if (!task) {
    res.status(400).json({ error: 'Missing task' });
    return;
  }

  try {
    if (watch) {
      await orchestrateCommand(task, { sessionId, watch: true });
      res.json({ success: true, message: 'Orchestration started, streaming via WebSocket' });
    } else {
      const result = await orchestrateCommand(task, { sessionId });
      res.json({ success: true, result });
    }
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// API: 触发状态转换
app.post('/api/v1/workflow/:workflowId/transition', async (req, res) => {
  const { workflowId } = req.params;
  const { trigger, context } = req.body;
  
  if (!trigger) {
    res.status(400).json({ error: 'Missing trigger' });
    return;
  }

  try {
    const fsm = getOrCreateWorkflowFSM({
      workflowId,
      sessionId: req.body.sessionId || workflowId,
    });

    const success = await fsm.trigger(trigger as any, context);
    
    if (!success) {
      res.status(400).json({ error: 'Transition failed', trigger, currentState: fsm.getState() });
      return;
    }

    res.json({
      success: true,
      currentState: fsm.getState(),
      context: fsm.getContext(),
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

console.log('[Server] Agent CLI API enabled');

// API: Execute agent command (agent + command + params)
app.post('/api/v1/agent/execute-command', async (req, res) => {
  const { agent, command, params } = req.body;
  if (!agent || !command) {
    res.status(400).json({ error: 'Missing agent or command' });
    return;
  }

  try {
    // 直接调用 agent 模块的 execute 方法
    const { ModuleRegistry } = await import('../orchestration/module-registry.js');
    // 使用全局 registry 实例
    const globalRegistry = (global as any).__moduleRegistry || new ModuleRegistry((global as any).__messageHub);
    const modules = globalRegistry.getModulesByType('agent');
    const agentModule: any = modules.find((m: any) => m.id === agent);
    
    if (!agentModule || !('execute' in agentModule)) {
      res.status(404).json({ error: `Agent ${agent} not found` });
      return;
    }
    
    const result = await (agentModule as any).execute(command, params);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
