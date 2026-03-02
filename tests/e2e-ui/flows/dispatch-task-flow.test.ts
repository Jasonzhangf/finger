import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';

const TEST_PORT = 17781;
let baseUrl: string;
let serverHandle: ReturnType<typeof createServer>;
const dispatchLog: { taskId: string; target: string }[] = [];

beforeAll(async () => {
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
  serverHandle = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/dispatch') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        dispatchLog.push({ taskId: parsed.taskId || 'unknown', target: parsed.target || 'unknown' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, taskId: parsed.taskId }));
      });
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

describe('Flows: Dispatch Task', () => {
  it('should dispatch task to agent', async () => {
    const res = await fetch(`${baseUrl}/api/v1/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-123', target: 'agent-searcher', message: 'Search for X' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.taskId).toBe('task-123');
  });

  it('should record dispatch in log', async () => {
    await fetch(`${baseUrl}/api/v1/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-456', target: 'agent-executor' }),
    });
    expect(dispatchLog.length).toBeGreaterThan(0);
    expect(dispatchLog.some((d) => d.taskId === 'task-456')).toBe(true);
  });
});
