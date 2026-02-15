import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registry } from '../core/registry.js';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { MessageHub } from '../orchestration/message-hub.js';
import { ModuleRegistry } from '../orchestration/module-registry.js';
import { echoInput, echoOutput } from '../agents/test/mock-echo-agent.js';
import { createRealOrchestratorModule } from '../agents/daemon/orchestrator-module.js';
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

app.post('/api/blocks/:id/exec', async (req, res) => {
  const { command, args } = req.body as { command?: string; args?: Record<string, unknown> };
  if (!command) {
    res.status(400).json({ error: 'Missing command' });
    return;
  }

  try {
    const result = await registry.execute(req.params.id, command, args || {});
    res.json({ success: true, result });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: errorMessage });
  }
});

app.get('/api/state', (_req, res) => {
  const block = registry.getBlock('state-1');
  if (!block || block.type !== 'state') {
    res.status(404).json({ error: 'State block not available' });
    return;
  }

  block.execute('snapshot', {})
    .then(state => res.json(state))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/test/state/:key', (req, res) => {
  const block = registry.getBlock('state-1');
  if (!block || block.type !== 'state') {
    res.status(404).json({ error: 'State block not available' });
    return;
  }

  block.execute('get', { key: req.params.key })
    .then(value => res.json({ key: req.params.key, value }))
    .catch(err => res.status(500).json({ error: err.message }));
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

app.post('/api/v1/message', async (req, res) => {
  const body = req.body as { target?: string; message?: unknown; blocking?: boolean };
  if (!body.target || body.message === undefined) {
    res.status(400).json({ error: 'Missing target or message' });
    return;
  }

  try {
    if (body.blocking) {
      const result = await hub.sendToModule(body.target, body.message as any);
      res.json({ success: true, result });
      return;
    }

    hub.sendToModule(body.target, body.message as any).catch((err) => {
      console.error('[Hub] Send error:', err);
    });
    res.json({ success: true, queued: true });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: errorMessage });
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
