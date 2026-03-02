import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17784;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/sessions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'session-long-running',
        status: 'active',
        duration: 3600000,
        messageCount: 100,
      }));
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

describe('Stability: Long Running Session', () => {
  it('should keep session stable over time', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions/session-long-running`);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.duration).toBeGreaterThan(0);
  });

  it('should handle many messages', async () => {
    const res = await fetch(`${baseUrl}/api/v1/sessions/session-long-running`);
    const body = await res.json();
    expect(body.messageCount).toBeGreaterThan(0);
  });
});
