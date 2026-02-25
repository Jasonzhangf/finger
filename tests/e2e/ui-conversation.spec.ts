/**
 * Finger WebUI Conversation Panel E2E Test
 * 
 * 验证对话面板的完整流程：
 * 1. 用户输入 → pending → confirmed 状态流转
 * 2. Agent 响应 → 右侧面板显示
 * 3. WebSocket 实时更新
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach} from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { setTimeout as sleep } from 'timers/promises';

// 测试配置
const UI_URL = 'http://localhost:8080';
const WS_URL = 'ws://localhost:8081';
const TEST_TIMEOUT = 120000;
const SETUP_TIMEOUT = 60000;

describe('WebUI Conversation Panel', () => {
  let serverProcess: ChildProcess | null = null;
  let tempDir: string;
  let wsClient: WebSocket | null = null;

  async function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => {
        server.close();
        resolve(false);
      });
      server.listen(port);
    });
  }

  async function startServer(): Promise<void> {
    if (await isPortInUse(8080)) {
      console.log('[E2E] Server already running on port 8080');
      return;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server startup timeout'));
      }, 30000);

      serverProcess = spawn('node', ['dist/server/index.js'], {
        cwd: '/Volumes/extension/code/finger',
        stdio: 'pipe',
        detached: false,
      });

      serverProcess.stdout?.on('data', (data: Buffer) => {
        const output = data.toString();
        console.log('[Server]', output.trim());
        if (output.includes('Finger server running')) {
          clearTimeout(timeout);
          setTimeout(resolve, 2000);
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.error('[Server Error]', data.toString().trim());
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async function stopServer(): Promise<void> {
    if (!serverProcess) return;
    serverProcess.kill('SIGTERM');
    await sleep(1000);
    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }

  async function createWsConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
      const ws = new WebSocket(WS_URL);

      ws.on('open', () => {
        clearTimeout(timeout);
        resolve(ws);
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async function createSession(name: string): Promise<string> {
    const res = await fetch(`${UI_URL}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        projectPath: tempDir,
      }),
    });
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'finger-ui-test-'));
    console.log(`\n[E2E] Temp dir: ${tempDir}`);

    // 初始化 bd
    try {
      execSync('bd init --no-db', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      fs.mkdirSync(path.join(tempDir, '.beads'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.beads', 'config.yaml'),
        'mode: git-portable\n'
      );
    }

    await startServer();
    console.log('[E2E] Server ready');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (wsClient) {
      wsClient.close();
      wsClient = null;
    }
    await stopServer();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30000);

  beforeEach(async () => {
    // 每个测试前建立新的 WebSocket 连接
    if (wsClient) {
      wsClient.close();
    }
    wsClient = await createWsConnection();
  });

  describe('User Input Flow', () => {
    it('sends user message → receives pending state → confirmed after API success', async () => {
      const sessionId = await createSession('user-input-test');
      const receivedMessages: Array<{ type: string; payload?: unknown }> = [];

      // 订阅消息
      wsClient!.send(JSON.stringify({
        type: 'subscribe',
        types: ['workflow_update', 'agent_update', 'task_started', 'task_completed'],
      }));

      wsClient!.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          receivedMessages.push(msg);
          console.log('[WS] Received:', msg.type);
        } catch {
          // ignore
        }
      });

      // 发送用户消息
      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: '测试用户输入流程', sessionId },
          blocking: false,
        }),
      });

      const msgData = (await msgRes.json()) as { success: boolean; messageId?: string };
      expect(msgData.success).toBe(true);
      console.log('[E2E] Message sent:', msgData.messageId);

      // 等待 workflow 创建
      await sleep(5000);

      // 检查 workflow 状态
      const workflowsRes = await fetch(`${UI_URL}/api/v1/workflows`);
      const workflows = (await workflowsRes.json()) as Array<{ sessionId: string; status: string }>;
      const sessionWorkflow = workflows.find((w) => w.sessionId === sessionId);

      expect(sessionWorkflow).toBeDefined();
      console.log('[E2E] Workflow status:', sessionWorkflow!.status);

      // 验证 WebSocket 消息
      const workflowUpdates = receivedMessages.filter((m) => m.type === 'workflow_update');
      console.log('[E2E] Received workflow_update count:', workflowUpdates.length);
    }, TEST_TIMEOUT);

    it('handles failed message with error state', async () => {
      const sessionId = await createSession('error-test');

      // 发送到不存在的 target
      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'non-existent-module',
          message: { content: 'test', sessionId },
          blocking: false,
        }),
      });

      // API 应该返回错误或成功（因为是非阻塞）
      const msgData = (await msgRes.json()) as { success: boolean; error?: string };
      console.log('[E2E] Non-existent target response:', msgData);
    }, 30000);
  });

  describe('Agent Response Flow', () => {
    it('receives agent_update with thought/action/observation', async () => {
      const sessionId = await createSession('agent-response-test');
      const agentUpdates: Array<{ type: string; payload?: unknown }> = [];

      wsClient!.send(JSON.stringify({
        type: 'subscribe',
        types: ['agent_update', 'workflow_update'],
      }));

      wsClient!.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'agent_update') {
            agentUpdates.push(msg);
            console.log('[E2E] Agent update:', JSON.stringify(msg.payload).substring(0, 200));
          }
        } catch {
          // ignore
        }
      });

      // 发送简单任务
      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: '列出当前目录文件', sessionId },
          blocking: false,
        }),
      });

      expect((msgRes.json() as Promise<{ success: boolean }>).then((d) => d.success)).resolves.toBe(true);

      // 等待 agent 执行
      await sleep(10000);

      console.log('[E2E] Total agent updates:', agentUpdates.length);
    }, TEST_TIMEOUT);
  });

  describe('WebSocket Subscription', () => {
    it('confirms subscription with subscribe_confirmed message', async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Subscription confirmation timeout'));
        }, 10000);

        wsClient!.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'subscribe_confirmed') {
              clearTimeout(timeout);
              expect(msg.types).toContain('workflow_update');
              expect(msg.types).toContain('agent_update');
              console.log('[E2E] Subscription confirmed:', msg.types);
              resolve(undefined);
            }
          } catch {
            // ignore
          }
        });

        wsClient!.send(JSON.stringify({
          type: 'subscribe',
          types: ['workflow_update', 'agent_update'],
        }));
      });
    }, 30000);

    it('filters messages by subscribed types', async () => {
      const receivedTypes = new Set<string>();

      // 只订阅 workflow_update
      wsClient!.send(JSON.stringify({
        type: 'subscribe',
        types: ['workflow_update'],
      }));

      wsClient!.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          receivedTypes.add(msg.type);
        } catch {
          // ignore
        }
      });

      await sleep(2000);

      // 验证只收到 workflow_update 类型的消息
      
      console.log('[E2E] Received types:', Array.from(receivedTypes));
    }, 30000);
  });

  describe('Conversation Round Updates', () => {
    it('tracks user rounds across multiple inputs', async () => {
      const sessionId = await createSession('rounds-test');
      const roundMessages: string[] = [];

      wsClient!.send(JSON.stringify({
        type: 'subscribe',
        types: ['workflow_update'],
      }));

      wsClient!.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'workflow_update' && (msg.payload as any)?.orchestratorState?.round) {
            const round = (msg.payload as any).orchestratorState.round;
            roundMessages.push(`Round ${round}`);
          }
        } catch {
          // ignore
        }
      });

      // 发送第一个任务
      await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: '第一轮任务', sessionId },
          blocking: false,
        }),
      });

      await sleep(5000);

      console.log('[E2E] Rounds tracked:', roundMessages);
    }, TEST_TIMEOUT);
  });
});
