import express from 'express';
import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { registry } from '../core/registry.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { RuntimeFacade } from '../runtime/runtime-facade.js';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ModuleRegistry } from '../orchestration/module-registry.js';
// SessionManager accessed via shared-instances
import { sharedWorkflowManager, sharedMessageHub, sharedSessionManager } from '../orchestration/shared-instances.js';
import { runtimeInstructionBus } from '../orchestration/runtime-instruction-bus.js';
import { resourcePool } from '../orchestration/resource-pool.js';
import { resumableSessionManager } from '../orchestration/resumable-session.js';
import { echoInput, echoOutput } from '../agents/test/mock-echo-agent.js';
import { createRealOrchestratorModule } from '../agents/daemon/orchestrator-module.js';
import { createOrchestratorLoop } from '../agents/daemon/orchestrator-loop.js';
import { createExecutorLoop } from '../agents/daemon/executor-loop.js';
import { mailbox } from './mailbox.js';
import type { OutputModule } from '../orchestration/module-registry.js';
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

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
app.use(express.json());

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
await moduleRegistry.register(echoInput);
await moduleRegistry.register(echoOutput);

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

moduleRegistry.createRoute(() => true, 'echo-output', {
  blocking: false,
  priority: 0,
  description: 'default route to echo-output'
});
console.log('[Server] Orchestration modules initialized: echo-input, echo-output, orchestrator-1, executor-mock');

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
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

app.post('/api/v1/mailbox/clear', (_req, res) => {
  mailbox.cleanup();
  res.json({ success: true, message: 'Mailbox cleaned up' });
});

// WebSocket server for real-time updates
const wsPort = PORT + 1;
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

const SESSIONS_DIR = join(homedir(), '.finger', 'sessions');
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
    // Load session info
    const sessionFile = join(SESSIONS_DIR, `${sessionId}.json`);
    const sessionContent = await readFile(sessionFile, 'utf-8');
    const session = JSON.parse(sessionContent);
    
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
  const body = req.body as { target?: string; message?: unknown; blocking?: boolean; sender?: string };
  if (!body.target || body.message === undefined) {
    res.status(400).json({ error: 'Missing target or message' });
    return;
  }

  // Create mailbox message for tracking
  const messageId = mailbox.createMessage(body.target, body.message, body.sender);
  mailbox.updateStatus(messageId, 'processing');

  // Broadcast to WebSocket clients
  const broadcastMsg = JSON.stringify({ type: 'messageCreated', messageId, status: 'processing' });
  for (const client of wsClients) {
    if (client.readyState === 1) client.send(broadcastMsg);
  }

  try {
    if (body.blocking) {
      const result = await hub.sendToModule(body.target, body.message);
      mailbox.updateStatus(messageId, 'completed', result);
      
      // Broadcast completion
      const completeBroadcast = JSON.stringify({ type: 'messageCompleted', messageId, result });
      for (const client of wsClients) {
        if (client.readyState === 1) client.send(completeBroadcast);
      }
      
      res.json({ success: true, messageId, result });
      return;
    }

    // Non-blocking: return messageId immediately
    hub.sendToModule(body.target, body.message)
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
    
    res.json({ success: true, messageId, queued: true });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
    res.status(400).json({ error: errorMessage, messageId });
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
} from './orchestration/workflow-state-bridge.js';

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
const originalWsServer = wsServer; // 保存原始 wsServer 引用
wsServer.on('connection', (ws) => {
  registerWebSocketClient(ws);
  
  ws.on('close', () => {
    unregisterWebSocketClient(ws);
  });
});

console.log('[Server] State Bridge integration enabled');
