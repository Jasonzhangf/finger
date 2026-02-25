/**
 * Message API E2E
 * 验证 /api/v1/message 在 blocking 模式下返回真实处理结果，而不是原始消息
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 5531;
const TEST_WS_PORT = 5532;

let daemonProcess: ChildProcess | null = null;

async function startDaemon(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(TEST_PORT),
      WS_PORT: String(TEST_WS_PORT),
    };

    const daemonPath = path.resolve(__dirname, '../../dist/server/index.js');
    daemonProcess = spawn('node', [daemonPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let settled = false;

    daemonProcess.stdout?.on('data', (buf) => {
      const out = buf.toString();
      if (!settled && out.includes(`Finger server running at http://localhost:${TEST_PORT}`)) {
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
        reject(new Error('Daemon startup timeout in message-api.e2e'));
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

describe('Message API E2E', () => {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const build = spawn('npm', ['run', 'build'], { cwd: path.resolve(__dirname, '../..'), stdio: 'pipe' });
      build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
      build.on('error', reject);
    });

    await startDaemon();
  }, 40000);

  afterAll(async () => {
    await stopDaemon();
  });

  it('returns processed result (not original message) in blocking mode', async () => {
    const payload = {
      target: 'echo-input',
      message: {
        type: 'message-api-e2e',
        text: 'processed-result-check',
        nested: { key: 'value' },
      },
      blocking: true,
    };

    const response = await fetch(`http://localhost:${TEST_PORT}/api/v1/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      messageId?: string;
      status?: string;
      result?: unknown;
    };

    expect(body.messageId).toBeTypeOf('string');
    expect(body.status).toBe('completed');

    const result = body.result as { received?: { text?: string }; handler?: string };
    expect(result.handler).toBe('echo-input');
    expect(result.received?.text).toBe('processed-result-check');

    // 核心断言：响应不是把原始 message 直接作为 result 返回
    expect((body.result as { nested?: unknown }).nested).toBeUndefined();
  });

  it('returns explicit failed response for unknown target in blocking mode', async () => {
    const response = await fetch(`http://localhost:${TEST_PORT}/api/v1/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'not-exists-target',
        message: { ping: true },
        blocking: true,
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { status?: string; error?: string };
    expect(body.status).toBe('failed');
    expect(body.error).toContain('not registered as input or output');
  });
});
