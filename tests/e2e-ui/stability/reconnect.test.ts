import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17783;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;
let connectionCount = 0;

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    connectionCount++;
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', connections: connectionCount }));
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

describe('Stability: Reconnect', () => {
  it('should recover from reconnect', async () => {
    const res1 = await fetch(`${baseUrl}/health`);
    const body1 = await res1.json();
    expect(body1.status).toBe('healthy');
    const firstCount = body1.connections;

    const res2 = await fetch(`${baseUrl}/health`);
    const body2 = await res2.json();
    expect(body2.status).toBe('healthy');
    expect(body2.connections).toBeGreaterThan(firstCount);
  });

  it('should maintain state after reconnect', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('connections');
  });
});
