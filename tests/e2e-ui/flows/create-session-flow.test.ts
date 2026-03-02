import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17780;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;
const sessions: { id: string; status: string }[] = [];

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      const id = `session-${Date.now()}`;
      sessions.push({ id, status: 'active' });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, status: 'active' }));
    } else if (req.method === 'GET' && req.url === '/api/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
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

describe('Flows: Create Session', () => {
  it('should create a new session via POST', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('status', 'active');
  });

  it('should list created session', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});
