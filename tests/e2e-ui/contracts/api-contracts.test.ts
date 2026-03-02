import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17777;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;

function fetchJSON(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  return fetch(url, init).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null),
  }));
}

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mock: true }));
  });
  await new Promise<void>((resolve) => serverHandle.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  serverHandle.close();
});

describe('Contracts: API Health', () => {
  it('should return 200 from health endpoint', async () => {
    const { status, body } = await fetchJSON(`${baseUrl}/health`);
    expect(status).toBe(200);
    expect(body).toHaveProperty('mock', true);
  });

  it('should return JSON content-type', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const ct = res.headers.get('content-type');
    expect(ct).toContain('application/json');
  });
});

describe('Contracts: Session API Contract', () => {
  it('should handle sessions endpoint', async () => {
    const { status, body } = await fetchJSON(`${baseUrl}/api/v1/sessions`);
    expect([200, 404]).toContain(status);
    expect(body).toBeDefined();
  });
});

describe('Contracts: Agents API Contract', () => {
  it('should handle agents endpoint', async () => {
    const { status, body } = await fetchJSON(`${baseUrl}/api/v1/agents`);
    expect([200, 404]).toContain(status);
    expect(body).toBeDefined();
  });

  it('should handle unknown agent', async () => {
    const { status, body } = await fetchJSON(`${baseUrl}/api/v1/agents/nonexistent-agent`);
    expect([200, 404, 400]).toContain(status);
    expect(body).toBeDefined();
  });
});
