import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registry } from '../../src/core/registry.js';
import express from 'express';
import { StateBlock } from '../../src/blocks/index.js';

let app: express.Express;
let server: any;
let baseUrl = '';

beforeAll(async () => {
  (registry as any).blocks.clear();
  (registry as any).registrations.clear();

  app = express();
  app.use(express.json());

  registry.register({ type: 'state', factory: (config) => new StateBlock(config.id as string), version: '1.0.0' });

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

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.close();
  await registry.destroyAll();
  (registry as any).registrations.clear();
});

describe('State API', () => {
  it('should list all blocks', async () => {
    const res = await fetch(`${baseUrl}/api/blocks`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((b: any) => b.type === 'state')).toBe(true);
  });

  it('should get state block status', async () => {
    const res = await fetch(`${baseUrl}/api/blocks/state-1/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('state-1');
    expect(body.status).toBe('idle');
  });

  it('should return 404 for unknown block', async () => {
    const res = await fetch(`${baseUrl}/api/blocks/unknown/state`);
    expect(res.status).toBe(404);
  });

  it('should execute set command on state block', async () => {
    const setRes = await fetch(`${baseUrl}/api/blocks/state-1/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'set', args: { key: 'foo', value: 'bar' } }),
    });
    expect(setRes.status).toBe(200);
    const setBody = await setRes.json();
    expect(setBody.success).toBe(true);
    expect(setBody.result.key).toBe('foo');
    expect(setBody.result.updated).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/test/state/foo`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.value).toBe('bar');
  });

  it('should execute get command on state block', async () => {
    const getRes = await fetch(`${baseUrl}/api/blocks/state-1/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'get', args: { key: 'foo' } }),
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.success).toBe(true);
    expect(body.result).toBe('bar');
  });

  it('should return error for invalid command', async () => {
    const res = await fetch(`${baseUrl}/api/blocks/state-1/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'invalid', args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Unknown command');
  });
});
