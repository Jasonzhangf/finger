import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registry } from '../core/registry.js';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { MessageHub } from '../orchestration/message-hub.js';
import { ModuleRegistry } from '../orchestration/module-registry.js';
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

const hub = new MessageHub();
const moduleRegistry = new ModuleRegistry(hub);
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
const wsClients: Set<WebSocket> = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && msg.messageId) {
        // Subscribe to message updates
        mailbox.subscribe(msg.messageId, (m) => {
          ws.send(JSON.stringify({ type: 'messageUpdate', message: m }));
        });
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
