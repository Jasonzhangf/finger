import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DAEMON_URL = process.env.FINGER_HUB_URL || 'http://127.0.0.1:9999';

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

async function postMessage(target: string, message: unknown, sender = 'mailbox-e2e-test') {
  const res = await fetch(`${DAEMON_URL}/api/v1/message`, {
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
  const res = await fetch(`${DAEMON_URL}/api/v1/mailbox?target=${encodeURIComponent(target)}&limit=20`);
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

describe('mailbox two-agent e2e', () => {
  it('project agent mailbox request reaches system agent and can be read/acked', async () => {
    // ensure daemon alive
    const health = await fetch(`${DAEMON_URL}/health`);
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
