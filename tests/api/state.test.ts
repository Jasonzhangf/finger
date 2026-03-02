import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registry } from '../../src/core/registry.js';
import express from 'express';
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
} from '../../src/blocks/index.js';

let app: express.Express;
let server: any;

beforeAll(async () => {
  app = express();
  app.use(express.json());

  registry.register({ type: 'state', factory: (config) => new StateBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'task', factory: (config) => new TaskBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'agent', factory: (config) => new AgentBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'eventbus', factory: (config) => new EventBusBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'storage', factory: (config) => new StorageBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'session', factory: (config) => new SessionBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'ai', factory: (config) => new AIBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'project', factory: (config) => new ProjectBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'orchestrator', factory: (config) => new OrchestratorBlock(config.id as string), version: '1.0.0' });
  registry.register({ type: 'websocket', factory: (config) => new WebSocketBlock(config.id as string), version: '1.0.0' });

  registry.createInstance('state', 'state-1');
  await registry.initializeAll();

  app.get('/api/blocks', (req, res) => { res.json(registry.generateApiEndpoints()); });
  app.get('/api/blocks/:id/state', (req, res) => {
    const block = registry.getBlock(req.params.id);
    if (!block) { res.status(404).json({ error: 'Block not found' }); return; }
    res.json(block.getState());
  });
  app.post('/api/blocks/:id/exec', async (req, res) => {
    const { command, args } = req.body;
    if (!command) { res.status(400).json({ error: 'Missing command' }); return; }
    try {
      const result = await registry.execute(req.params.id, command, args || {});
      res.json({ success: true, result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get('/api/test/state/:key', (req, res) => {
    const block = registry.getBlock('state-1');
    if (!block || block.type !== 'state') { res.status(404).json({ error: 'State block not available' }); return; }
    block.execute('get', { key: req.params.key })
      .then(value => res.json({ key: req.params.key, value }))
      .catch(err => res.status(500).json({ error: err.message }));
  });

  server = app.listen(0);
});

afterAll(() => {
  server.close();
});

describe.skip('State API (requires supertest)', () => {
  it('should list all blocks', async () => {
    const res = await request(app).get('/api/blocks').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((b: any) => b.type === 'state')).toBe(true);
  });

  it('should get state block status', async () => {
    const res = await request(app).get('/api/blocks/state-1/state').expect(200);
    expect(res.body.id).toBe('state-1');
    expect(res.body.status).toBe('idle');
  });

  it('should return 404 for unknown block', async () => {
    await request(app).get('/api/blocks/unknown/state').expect(404);
  });

  it('should execute set command on state block', async () => {
    const setRes = await request(app)
      .post('/api/blocks/state-1/exec')
      .send({ command: 'set', args: { key: 'foo', value: 'bar' } })
      .expect(200);
    expect(setRes.body.success).toBe(true);
    expect(setRes.body.result.key).toBe('foo');
    expect(setRes.body.result.updated).toBe(true);

    const getRes = await request(app).get('/api/test/state/foo').expect(200);
    expect(getRes.body.value).toBe('bar');
  });

  it('should execute get command on state block', async () => {
    const getRes = await request(app)
      .post('/api/blocks/state-1/exec')
      .send({ command: 'get', args: { key: 'foo' } })
      .expect(200);
    expect(getRes.body.success).toBe(true);
    expect(getRes.body.result).toBe('bar');
  });

  it('should return error for invalid command', async () => {
    const res = await request(app)
      .post('/api/blocks/state-1/exec')
      .send({ command: 'invalid', args: {} })
      .expect(400);
    expect(res.body.error).toContain('Unknown command');
  });
});
