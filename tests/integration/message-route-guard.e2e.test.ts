import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 5533;
const TEST_WS_PORT = 5534;

let daemonProcess: ChildProcess | null = null;

async function buildBackend(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn('npm', ['run', 'build:backend'], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'pipe',
    });
    build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
    build.on('error', reject);
  });
}

async function startDaemon(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      WS_PORT: String(TEST_WS_PORT),
      NODE_ENV: 'production',
      FINGER_ALLOW_DIRECT_AGENT_ROUTE: '0',
    };

    const daemonPath = path.resolve(__dirname, '../../dist/server/index.js');
    daemonProcess = spawn('node', [daemonPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;
    daemonProcess.stdout?.on('data', (buf) => {
      const output = buf.toString();
      if (!settled && output.includes(`Finger server running at http://localhost:${TEST_PORT}`)) {
        settled = true;
        setTimeout(resolve, 300);
      }
    });
    daemonProcess.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('daemon startup timeout in message-route-guard.e2e'));
      }
    }, 15000);
  });
}

async function stopDaemon(): Promise<void> {
  if (!daemonProcess) return;
  daemonProcess.kill('SIGTERM');
  daemonProcess = null;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe('Message Route Guard E2E', () => {
  beforeAll(async () => {
    await buildBackend();
    await startDaemon();
  }, 30000);

  afterAll(async () => {
    await stopDaemon();
  });

  it('rejects direct non-orchestrator target route by default', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/api/v1/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'echo-input',
        message: { text: 'blocked route check' },
        blocking: true,
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string; primaryTarget?: string };
    expect(body.code).toBe('DIRECT_ROUTE_DISABLED');
    expect(body.primaryTarget).toBe('chat-codex-gateway');
  });

  it('allows direct route only in explicit test mode', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/api/v1/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-finger-route-mode': 'test',
      },
      body: JSON.stringify({
        target: 'echo-input',
        message: { text: 'test route allowed' },
        blocking: true,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status?: string;
      result?: { handler?: string; received?: { text?: string } };
    };
    expect(body.status).toBe('completed');
    expect(body.result?.handler).toBe('echo-input');
    expect(body.result?.received?.text).toBe('test route allowed');
  });
});
