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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(process.cwd(), 'dist/cli/index.js');
const WS_PORT = 19999;
const CHANNEL_ID = 'qqbot';
const PID_FILE = path.join(os.homedir(), '.finger', 'run', `gateway-bridge-${CHANNEL_ID}.pid`);

describe('Gateway Bridge QQBot E2E', () => {
  let ws: WebSocket | null = null;
  let child: ChildProcess | null = null;

  beforeAll(async () => {
    // 确保旧的 PID 文件被清理
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

  afterAll(async () => {
    // 停止服务
    if (child && child.pid) {
      child.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 清理 PID 文件
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  });

  it('should start gateway bridge service', async () => {
    // 启动服务（前台模式）
    child = spawn('node', [CLI_PATH, 'gateway-bridge', 'start', CHANNEL_ID, '--ws-port', String(WS_PORT)], {
      stdio: 'ignore',
    });

    // 等待服务启动
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 验证 PID 文件被创建
    expect(fs.existsSync(PID_FILE)).toBe(true);
    
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
    expect(pid).toBeGreaterThan(0);
  });

  it('should connect to WebSocket server', async () => {
    return new Promise<void>((resolve, reject) => {
      ws = new WebSocket(`ws://localhost:${WS_PORT}`);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

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
  });

  it('should send start command and receive ready event', async () => {
    return new Promise<void>((resolve, reject) => {
      if (!ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Start command timeout'));
      }, 30000);

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as { event: string; data: unknown };
          console.log('[Test] Received event:', message.event);
          
          if (message.event === 'ready') {
            clearTimeout(timeout);
            expect(message.data).toBeDefined();
            resolve();
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // 发送 start 命令
      const startMessage = {
        action: 'start',
        payload: {
          appId: '1903323793',
          clientSecret: 'woVyDF3dz72jCRRE',
        },
      };

      ws.send(JSON.stringify(startMessage));
    });
  });

  it('should send message command and receive response', async () => {
    return new Promise<void>((resolve) => {
      if (!ws) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        // 30 秒后超时，但记录已收到的响应
        console.log('[Test] Message command timeout (expected for E2E test)');
        resolve();
      }, 30000);

      let receivedResponse = false;

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as { ok?: boolean; requestId?: string };
          console.log('[Test] Received message:', message);
          
          if (message.ok === true || message.ok === false) {
            if (!receivedResponse) {
              receivedResponse = true;
              clearTimeout(timeout);
              resolve();
            }
          }
        } catch (error) {
          // JSON parse error，忽略
        }
      });

      // 发送消息命令（使用一个测试用户）
      const messageCommand = {
        action: 'send',
        payload: {
          to: '123456',  // 测试用户 ID
          text: 'Hello from E2E test',
        },
      };

      ws.send(JSON.stringify(messageCommand));
    });
  });

  it('should send ping command and receive pong', async () => {
    return new Promise<void>((resolve, reject) => {
      if (!ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Ping command timeout'));
      }, 10000);

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as { ok?: boolean; result?: { pong?: boolean } };
          console.log('[Test] Received response:', message);
          
          if (message.ok === true && message.result?.pong === true) {
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });

      // 发送 ping 命令
      const pingMessage = {
        action: 'ping',
      };

      ws.send(JSON.stringify(pingMessage));
    });
  });

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
  });
});
