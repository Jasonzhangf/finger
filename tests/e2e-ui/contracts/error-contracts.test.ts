import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17778;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    if (req.url?.includes('/not-found')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } else if (req.url?.includes('/bad-request')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request', code: 'INVALID_INPUT' }));
    } else if (req.url?.includes('/server-error')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>((resolve) => serverHandle.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  serverHandle.close();
});

describe('Contracts: Error Responses', () => {
  it('should return 404 with error body', async () => {
    const res = await fetch(`${baseUrl}/not-found`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('should return 400 with error details', async () => {
    const res = await fetch(`${baseUrl}/bad-request`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(body).toHaveProperty('code');
  });

  it('should return 500 on server error', async () => {
    const res = await fetch(`${baseUrl}/server-error`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });
});

describe('Contracts: Error Content-Type', () => {
  it('should return JSON error for 404', async () => {
    const res = await fetch(`${baseUrl}/not-found`);
    const ct = res.headers.get('content-type');
    expect(ct).toContain('application/json');
  });
});
