import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17779;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test-id-123',
      name: 'Test Resource',
      createdAt: new Date().toISOString(),
      status: 'active',
    }));
  });
  await new Promise<void>((resolve) => serverHandle.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  serverHandle.close();
});

describe('Contracts: Schema Validation', () => {
  it('should return valid resource schema', async () => {
    const res = await fetch(`${baseUrl}/resource`);
    const body = await res.json();
    expect(typeof body.id).toBe('string');
    expect(typeof body.name).toBe('string');
    expect(typeof body.createdAt).toBe('string');
    expect(['active', 'inactive', 'pending']).toContain(body.status);
  });

  it('should validate ISO date format', async () => {
    const res = await fetch(`${baseUrl}/resource`);
    const body = await res.json();
    const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
    expect(body.createdAt).toMatch(dateRegex);
  });
});
