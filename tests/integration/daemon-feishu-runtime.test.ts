/**
 * Daemon Feishu Runtime Integration Test
 * 
 * 验证真实 daemon 后台进程 + HTTP 注册模块 + HTTP 消息收发端到端链路
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PORT = 5523;
const WS_PORT = 5524;
const FEISHU_MODULE_PATH = path.resolve(__dirname, '../../dist/agents/feishu/feishu-websocket-agent.js');

let daemonProcess: ChildProcess | null = null;

async function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(DAEMON_PORT), WS_PORT: String(WS_PORT) };
    const daemonPath = path.resolve(__dirname, '../../dist/server/index.js');
    
    daemonProcess = spawn('node', [daemonPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    
    let started = false;
    
    daemonProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log(`[Daemon] ${output.trim()}`);
      if ((output.includes('running at') || output.includes('listening')) && !started) {
        started = true;
        setTimeout(resolve, 500);
      }
    });
    
    daemonProcess.stderr?.on('data', (data) => {
      console.error(`[Daemon Error] ${data.toString().trim()}`);
    });
    
    daemonProcess.on('error', (err) => {
      if (!started) reject(err);
    });
    
    setTimeout(() => {
      if (!started) reject(new Error('Daemon startup timeout'));
    }, 10000);
  });
}

async function stopDaemon(): Promise<void> {
  if (daemonProcess) {
    daemonProcess.kill('SIGTERM');
    daemonProcess = null;
    
    const pidFile = path.join(homedir(), '.finger', 'daemon.pid');
    try {
      const fs = await import('fs');
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Ignore
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

describe('Daemon Feishu Runtime Integration - HTTP E2E', () => {
  beforeAll(async () => {
    const { exec } = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      exec('npm run build', { cwd: path.resolve(__dirname, '../..') }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    await startDaemon();
  }, 30000);

  afterAll(async () => {
    await stopDaemon();
  });

  it('should register feishu module via POST /api/v1/module/register', async () => {
    const registerUrl = `http://localhost:${DAEMON_PORT}/api/v1/module/register`;
    
    const response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: FEISHU_MODULE_PATH }),
    });
    
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
  });

  it('should route feishu.message end-to-end with blocking mode and verify output callback', async () => {
    const messageUrl = `http://localhost:${DAEMON_PORT}/api/v1/message`;
    
    const testMessage = {
      target: 'feishu-ws-input',
      message: {
        type: 'text',
        chatId: 'chat-blocking-001',
        userId: 'user-blocking-001',
        content: 'Blocking E2E test message',
        messageId: 'msg-blocking-001',
        timestamp: Date.now(),
      },
      blocking: true,
      sender: 'feishu-ws-output',
    };

    const response = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testMessage),
    });
    
    expect(response.status).toBe(200);
    const result = await response.json();
    
    expect(result.status).toBe('completed');
    expect(result).toHaveProperty('result');
    expect(result.result).toHaveProperty('success', true);
    expect(result.result).toHaveProperty('forwarded', true);
    // Verify output was actually executed
    expect(result.callbackResult).toBeDefined();
    expect(result.callbackResult).toHaveProperty('success', true);
  });

  it('should verify feishu module is registered and callable', async () => {
    const modulesUrl = `http://localhost:${DAEMON_PORT}/api/v1/modules`;
    const response = await fetch(modulesUrl);
    
    expect(response.status).toBe(200);
    const modulesData = await response.json();
    const modules = Array.isArray(modulesData) ? modulesData : (modulesData.modules || []);
    
    const feishuModule = modules.find((m: { id: string }) => m.id === 'feishu-websocket-agent');
    expect(feishuModule).toBeDefined();
    expect(feishuModule?.id).toBe('feishu-websocket-agent');
    expect(feishuModule?.type).toBe('agent');
  });

  it('should NOT route messages with non-matching type', async () => {
    const messageUrl = `http://localhost:${DAEMON_PORT}/api/v1/message`;
    
    const nonMatchingMessage = {
      target: 'feishu-ws-input',
      message: {
        type: 'other.type',
        chatId: 'chat-non-matching',
        userId: 'user-non-matching',
        content: 'This should not be routed to feishu output',
        messageId: 'msg-non-matching',
        timestamp: Date.now(),
      },
      blocking: true,
    };

    const response = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nonMatchingMessage),
    });
    
    expect(response.status).toBe(200);
    const result = await response.json();
    
    // Non-matching type should return forwarded: false
    expect(result.result?.forwarded).toBe(false);
    expect(result.result?.reason).toBe('Type mismatch');
  });

  it('should route callback to sender with matching name', async () => {
    const messageUrl = `http://localhost:${DAEMON_PORT}/api/v1/message`;
    
    const testMessage = {
      target: 'feishu-ws-input',
      message: {
        type: 'feishu.message',
        chatId: 'chat-sender-callback',
        userId: 'user-sender-callback',
        content: 'Testing sender callback routing',
        messageId: 'msg-sender-callback',
        timestamp: Date.now(),
      },
      blocking: true,
      sender: 'feishu-ws-output',
    };

    const response = await fetch(messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testMessage),
    });
    
    expect(response.status).toBe(200);
    const result = await response.json();
    
    // Verify message was processed successfully
    expect(result.status).toBe('completed');
    expect(result).toHaveProperty('messageId');
    
    // Verify callback result is included when sender is specified
    expect(result).toHaveProperty('callbackResult');
    expect(result.callbackResult).toHaveProperty('success', true);
  });
});
