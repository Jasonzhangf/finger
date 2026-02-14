import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { registry } from '../core/registry.js';
import { execSync } from 'child_process';
import { createServer } from 'net';
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

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

/**
 * Check if port is in use
 */
async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

/**
 * Kill process using the specified port
 */
function killProcessOnPort(port: number): void {
  try {
    const cmd = `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`;
    execSync(cmd, { stdio: 'ignore' });
    console.log(`[Server] Cleared port ${port}`);
  } catch {
    // Ignore errors - process might not exist
  }
}

/**
 * Ensure single instance by killing any process on the port
 */
async function ensureSingleInstance(port: number): Promise<void> {
  if (await isPortInUse(port)) {
    console.log(`[Server] Port ${port} is in use, killing existing process...`);
    killProcessOnPort(port);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

const app = express();

app.use(express.json());

// Serve static UI files
app.use(express.static(join(__dirname, '../../ui/dist')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../../ui/dist/index.html'));
});

// Request logger for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Test route to verify routing works
app.get('/api/test', (req, res) => {
  res.json({ ok: true, message: 'Test route works' });
});

// Register all block types
registry.register({
  type: 'task',
  factory: (config) => new TaskBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'agent',
  factory: (config) => new AgentBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'eventbus',
  factory: (config) => new EventBusBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'storage',
  factory: (config) => new StorageBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'session',
  factory: (config) => new SessionBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'ai',
  factory: (config) => new AIBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'project',
  factory: (config) => new ProjectBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'state',
  factory: (config) => new StateBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'orchestrator',
  factory: (config) => new OrchestratorBlock(config.id as string),
  version: '1.0.0'
});
registry.register({
  type: 'websocket',
  factory: (config) => new WebSocketBlock(config.id as string),
  version: '1.0.0'
});

// Create default instances
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

// API Routes
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/api/blocks', (req, res) => {
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
  const { command, args } = req.body;
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

// Get full state from state block
app.get('/api/state', (req, res) => {
  const block = registry.getBlock('state-1');
  if (!block || block.type !== 'state') {
    return res.status(404).json({ error: 'State block not available' });
  }
  block.execute('snapshot', {})
    .then(state => res.json(state))
    .catch(err => res.status(500).json({ error: err.message }));
});

// For state API testing - get current value of a specific key from state block
app.get('/api/test/state/:key', (req, res) => {
  const key = req.params.key;
  const block = registry.getBlock('state-1');
  if (!block || block.type !== 'state') {
    res.status(404).json({ error: 'State block not available' });
    return;
  }

  block.execute('get', { key })
    .then(value => res.json({ key, value }))
    .catch(err => res.status(500).json({ error: err.message }));
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
