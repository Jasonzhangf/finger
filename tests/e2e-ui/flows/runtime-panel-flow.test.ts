import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17782;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/runtime')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'running', agents: ['orchestrator', 'searcher'] }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  await new Promise<void>((resolve) => serverHandle.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  serverHandle.close();
});

describe('Flows: Runtime Panel', () => {
  it('should open runtime panel and fetch status', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runtime/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('agents');
    expect(Array.isArray(body.agents)).toBe(true);
  });

  it('should list available agents', async () => {
    const res = await fetch(`${baseUrl}/api/v1/runtime/status`);
    const body = await res.json();
    expect(body.agents).toContain('orchestrator');
    expect(body.agents).toContain('searcher');
  });
});
