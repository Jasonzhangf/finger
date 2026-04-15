/**
 * Gateway Bridge QQBot E2E Test
 * 
 * 真实测试 OpenClaw Gateway Bridge CLI 与 qqbot 的通信
 * 
 * 前置条件:
 * 1. qqbot 插件已安装到 /Volumes/extension/code/openclaw-qqbot
 * 2. qqbot 配置在 ~/.finger/runtime/plugins/openclaw-qqbot.json
 * 3. appId 和 clientSecret 有效
 * 
 * 测试流程:
 * 1. 启动 gateway bridge service (WebSocket 模式)
 * 2. 连接 WebSocket
 * 3. 发送 start 命令
 * 4. 验证 ready 事件
 * 5. 发送消息命令
 * 6. 验证响应
 * 7. 停止服务
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(process.cwd(), 'dist/cli/index.js');
const CHANNEL_ID = 'qqbot';
const PID_FILE = path.join(os.homedir(), '.finger', 'run', `gateway-bridge-${CHANNEL_ID}.pid`);

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

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  failureMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(failureMessage());
}

async function isPortReachable(wsPort: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: wsPort });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForWsPort(wsPort: number, timeoutMs = 30_000): Promise<void> {
  await waitForCondition(
    () => isPortReachable(wsPort),
    timeoutMs,
    () => `WebSocket server on port ${wsPort} did not become reachable`,
  );
}

async function waitForGatewayStartup(params: {
  child: ChildProcess;
  wsPort: number;
  timeoutMs: number;
  getOutput: () => string;
}): Promise<void> {
  const { child, wsPort, timeoutMs, getOutput } = params;

  await waitForCondition(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Gateway process exited before startup (exitCode=${child.exitCode}, signal=${child.signalCode})\n${getOutput()}`,
      );
    }

    if (!fs.existsSync(PID_FILE)) {
      return false;
    }

    return isPortReachable(wsPort);
  }, timeoutMs, () => `Gateway bridge did not finish startup in ${timeoutMs}ms\n${getOutput()}`);
}

describe('Gateway Bridge QQBot E2E', () => {
  let ws: WebSocket | null = null;
  let child: ChildProcess | null = null;
  let wsPort = 0;
  let gatewayOutput = '';

  async function waitForMessage(
    predicate: (message: Record<string, any>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, any>> {
    if (!ws) {
      throw new Error('WebSocket not connected');
    }

    return new Promise<Record<string, any>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws?.off('message', onMessage);
        reject(new Error(`Timed out waiting for gateway response\n${gatewayOutput}`));
      }, timeoutMs);

      const onMessage = (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, any>;
          console.log('[Test] Received message:', message);
          if (!predicate(message)) {
            return;
          }
          clearTimeout(timeout);
          ws?.off('message', onMessage);
          resolve(message);
        } catch (error) {
          clearTimeout(timeout);
          ws?.off('message', onMessage);
          reject(error);
        }
      };

      ws.on('message', onMessage);
    });
  }

  beforeAll(async () => {
    wsPort = await reservePort();
    gatewayOutput = '';

    // 确保旧的 PID 文件被清理
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

  afterAll(async () => {
    if (ws) {
      ws.close();
      ws = null;
    }

    // 停止服务
    if (child && child.pid) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child?.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    
    // 清理 PID 文件
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

it('should start gateway bridge service', async () => {
    // 启动服务（前台模式）
    child = spawn(process.execPath, [CLI_PATH, 'gateway-bridge', 'start', CHANNEL_ID, '--ws-port', String(wsPort)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data) => {
      gatewayOutput += data.toString();
    });
    child.stderr?.on('data', (data) => {
      gatewayOutput += data.toString();
    });

    await waitForGatewayStartup({
      child,
      wsPort,
      timeoutMs: 30_000,
      getOutput: () => gatewayOutput,
    });

    // 验证 PID 文件被创建
    expect(fs.existsSync(PID_FILE)).toBe(true);
    
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    expect(pid).toBeGreaterThan(0);
  }, 30_000);

it('should connect to WebSocket server', async () => {
    return new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

      const timeout = setTimeout(() => {
        reject(new Error(`WebSocket connection timeout\n${gatewayOutput}`));
      }, 30000);

      ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[Test] WebSocket connected');
        resolve();
      });

      ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }, 30_000);

  it('should send start command and receive ready event', async () => {
    if (!ws) {
      throw new Error('WebSocket not connected');
    }

    const requestId = `start-${Date.now()}`;
    const waiter = waitForMessage((message) => (
      message.event === 'ready'
      || (
        message.requestId === requestId
        && message.ok === true
        && message.result?.starting === true
        && message.result?.channelId === CHANNEL_ID
      )
    ), 30_000);

    ws.send(JSON.stringify({
      action: 'start',
      requestId,
      payload: {
        appId: '1903323793',
        clientSecret: 'woVyDF3dz72jCRRE',
      },
    }));

    const message = await waiter;
    if (message.event === 'ready') {
      expect(message.data).toBeDefined();
      return;
    }

    expect(message.requestId).toBe(requestId);
    expect(message.ok).toBe(true);
    expect(message.result?.starting).toBe(true);
    expect(message.result?.channelId).toBe(CHANNEL_ID);
  }, 30_000);

  it('should send message command and receive response', async () => {
    if (!ws) {
      throw new Error('WebSocket not connected');
    }

    const requestId = `send-${Date.now()}`;
    const waiter = waitForMessage(
      (message) => message.requestId === requestId && typeof message.ok === 'boolean',
      30_000,
    );

    ws.send(JSON.stringify({
      action: 'send',
      requestId,
      payload: {
        to: '123456',
        text: 'Hello from E2E test',
      },
    }));

    const message = await waiter;
    expect(message.requestId).toBe(requestId);
    expect(typeof message.ok).toBe('boolean');
  }, 30_000);

  it('should send ping command and receive pong', async () => {
    if (!ws) {
      throw new Error('WebSocket not connected');
    }

    const requestId = `ping-${Date.now()}`;
    const waiter = waitForMessage(
      (message) => message.requestId === requestId && message.ok === true && message.result?.pong === true,
      10_000,
    );

    ws.send(JSON.stringify({
      action: 'ping',
      requestId,
    }));

    const message = await waiter;
    expect(message.requestId).toBe(requestId);
    expect(message.ok).toBe(true);
    expect(message.result?.pong).toBe(true);
  }, 15_000);

  it('should stop gateway bridge service', async () => {
    return new Promise<void>((resolve) => {
      // 关闭 WebSocket
      if (ws) {
        ws.close();
      }

      // 停止服务
      if (child && child.pid) {
        child.kill('SIGTERM');
      }

      // 等待进程退出
      setTimeout(() => {
        // 验证 PID 文件被删除
        const pidExists = fs.existsSync(PID_FILE);
        expect(pidExists).toBe(false);
        resolve();
      }, 2000);
    });
  }, 10_000);
});
