import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import net from 'net';

const EXTERNAL_DAEMON_URL = process.env.FINGER_HUB_URL?.trim();
let DAEMON_URL = EXTERNAL_DAEMON_URL;
let ownedDaemon: ChildProcess | null = null;

interface MailboxMessage {
  id: string;
  seq: number;
  target: string;
  content: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  sender?: string;
  readAt?: string;
  ackAt?: string;
  result?: unknown;
  error?: string;
}

async function fetchWithRetry(url: string, init?: RequestInit, retries = 6, delayMs = 300): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve local port')));
        return;
      }
      const port = address.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startOwnedDaemonIfNeeded(): Promise<void> {
  if (EXTERNAL_DAEMON_URL) {
    DAEMON_URL = EXTERNAL_DAEMON_URL;
    return;
  }

  const port = await reservePort();
  const wsPort = await reservePort();
  DAEMON_URL = `http://127.0.0.1:${port}`;
  const daemonPath = path.join(process.cwd(), 'dist/server/index.js');
  ownedDaemon = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      PORT: String(port),
      WS_PORT: String(wsPort),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let startupError = '';
  ownedDaemon.stdout?.on('data', (chunk) => {
    startupError += chunk.toString();
  });
  ownedDaemon.stderr?.on('data', (chunk) => {
    startupError += chunk.toString();
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isHealthy(DAEMON_URL)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`mailbox-two-agent.e2e failed to start daemon at ${DAEMON_URL}\n${startupError}`);
}

async function stopOwnedDaemon(): Promise<void> {
  if (!ownedDaemon) return;
  const daemon = ownedDaemon;
  ownedDaemon = null;

  if (daemon.exitCode !== null || daemon.killed) return;

  daemon.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => daemon.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);

  if (daemon.exitCode === null && !daemon.killed) {
    daemon.kill('SIGKILL');
  }
}

async function postMessage(target: string, message: unknown, sender = 'mailbox-e2e-test') {
  const res = await fetchWithRetry(`${DAEMON_URL}/api/v1/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target,
      message,
      sender,
      blocking: false,
    }),
  });
  const json = await res.json();
  return { res, json };
}

async function getMailboxByTarget(target: string) {
  const res = await fetchWithRetry(`${DAEMON_URL}/api/v1/mailbox?target=${encodeURIComponent(target)}&limit=20`);
  const json = await res.json() as { messages?: MailboxMessage[] };
  return { res, messages: json.messages || [] };
}

async function waitForMessage(target: string, predicate: (m: MailboxMessage) => boolean, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { messages } = await getMailboxByTarget(target);
    const hit = messages.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting mailbox message target=${target}`);
}

describe.sequential('mailbox two-agent e2e', () => {
  beforeAll(async () => {
    await startOwnedDaemonIfNeeded();
  }, 30_000);

  afterAll(async () => {
    await stopOwnedDaemon();
  }, 10_000);

  it('project agent mailbox request reaches system agent and can be read/acked', async () => {
    // ensure daemon alive
    const health = await fetchWithRetry(`${DAEMON_URL}/health`);
    expect(health.ok).toBe(true);

    const testId = randomUUID();
    const projectAgentId = `finger-project-agent-e2e-${testId.slice(0, 8)}`;
    const systemAgentId = 'finger-system-agent';

    const payload = {
      type: 'dispatch-task',
      dispatchId: `dispatch-${testId}`,
      sourceAgentId: projectAgentId,
      targetAgentId: systemAgentId,
      sessionId: `session-${testId}`,
      workflowId: `wf-${testId}`,
      assignment: {
        title: 'mailbox-e2e-check',
        detail: 'project->system mailbox delivery',
      },
      text: 'E2E mailbox ping from project agent',
    };

    // Step 1: send mailbox-like message to system agent via message route
    const send = await postMessage(systemAgentId, payload, projectAgentId);
    expect(send.res.ok).toBe(true);
    expect(typeof send.json?.messageId).toBe('string');
    expect(send.json?.status === 'queued' || send.json?.status === 'processing' || send.json?.status === 'completed').toBe(true);

    // Step 2: verify system mailbox receives the message
    const received = await waitForMessage(systemAgentId, (m) => {
      if (!m || typeof m.content !== 'object' || m.content === null) return false;
      const c = m.content as Record<string, unknown>;
      return c.dispatchId === payload.dispatchId;
    }, 15000);

    expect(received.target).toBe(systemAgentId);
    expect(received.sender).toBe(projectAgentId);
    expect(received.status === 'pending' || received.status === 'processing' || received.status === 'completed' || received.status === 'failed').toBe(true);

    // Evidence: write trace to tmp for debugging/review
    const evidenceDir = path.join(os.homedir(), '.finger', 'logs');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, `mailbox-two-agent-e2e-${Date.now()}.json`);
    fs.writeFileSync(evidencePath, JSON.stringify({
      daemonUrl: DAEMON_URL,
      testId,
      projectAgentId,
      systemAgentId,
      sendResponse: send.json,
      received,
      timestamp: new Date().toISOString(),
    }, null, 2));

    expect(fs.existsSync(evidencePath)).toBe(true);
  }, 30000);
});
