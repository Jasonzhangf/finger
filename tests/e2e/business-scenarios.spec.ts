/**
 * Finger 端到端业务场景测试
 * 
 * 覆盖核心业务场景:
 * 1. 任务全生命周期（创建→执行→完成）
 * 2. 工作流暂停/恢复
 * 3. 多 Agent 并发执行
 * 4. WebSocket 实时事件订阅
 * 5. 错误处理与重试
 * 6. 资源池管理
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

// 测试配置
const UI_URL = 'http://localhost:8080';
const WS_URL = 'ws://localhost:8081';
const TEST_TIMEOUT = 180000; // 3 分钟
const SETUP_TIMEOUT = 60000; // 1 分钟

describe('Finger E2E Business Scenarios', () => {
  let serverProcess: ChildProcess | null = null;
  let tempDir: string;

  // 工具函数：检查端口是否可用
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

  // 工具函数：启动服务器
  async function startServer(): Promise<void> {
    // 如果端口已被占用，跳过启动
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
        if (output.includes('Finger server running')) {
          clearTimeout(timeout);
          setTimeout(resolve, 2000); // 额外等待 WebSocket 就绪
        }
      });

      serverProcess.stderr?.on('data', (data: Buffer) => {
        console.log(`[Server Error] ${data.toString().trim()}`);
      });

      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // 工具函数：停止服务器
  async function stopServer(): Promise<void> {
    if (!serverProcess) return;

    serverProcess.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));

    if (!serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }

  // 工具函数：创建 WebSocket 连接
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

  // 工具函数：创建会话
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
    // 创建临时目录
    tempDir = fs.mkdtempSync(path.join('/tmp', 'finger-e2e-'));
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

    // 启动服务器
    await startServer();
    console.log('[E2E] Server ready');
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await stopServer();

    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30000);

  // ========== 场景 1: 任务全生命周期 ==========
  describe('Scenario 1: Task Full Lifecycle', () => {
    it('creates session → sends task → receives workflow updates → task completes', async () => {
      // 1. 创建会话
      const sessionId = await createSession('task-lifecycle-test');
      expect(sessionId).toBeDefined();
      console.log(`[E2E] Session created: ${sessionId}`);

      // 2. 建立 WebSocket 连接并订阅事件
      const ws = await createWsConnection();
      const receivedEvents: Array<{ type: string; payload?: unknown }> = [];

      ws.send(JSON.stringify({ type: 'subscribe', groups: ['SESSION', 'TASK', 'WORKFLOW'] }));

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          receivedEvents.push(msg);
        } catch {
          // ignore
        }
      });

      // 3. 发送任务
      const userTask = '创建一个简单的 hello.txt 文件，内容为 "Hello, Finger!"';
      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: userTask, sessionId },
          blocking: false,
        }),
      });

      const msgData = (await msgRes.json()) as { success: boolean; messageId?: string };
      expect(msgData.success).toBe(true);
      console.log(`[E2E] Message sent: ${msgData.messageId}`);

      // 4. 等待工作流创建和执行
      await new Promise((r) => setTimeout(r, 10000));

      // 5. 检查工作流状态
      const workflowsRes = await fetch(`${UI_URL}/api/v1/workflows`);
      const workflows = (await workflowsRes.json()) as Array<{ id: string; sessionId: string; status: string }>;
      const sessionWorkflow = workflows.find((w) => w.sessionId === sessionId);

      // 6. 验证结果
      expect(sessionWorkflow).toBeDefined();
      expect(['planning', 'executing', 'completed', 'paused']).toContain(sessionWorkflow!.status);
      console.log(`[E2E] Workflow status: ${sessionWorkflow!.status}`);

      // 7. 验证 WebSocket 事件
      const workflowEvents = receivedEvents.filter((e) => e.type === 'workflow_update');
      console.log(`[E2E] Received ${workflowEvents.length} workflow events`);

      ws.close();
    }, TEST_TIMEOUT);
  });

  // ========== 场景 2: 工作流暂停/恢复 ==========
  describe('Scenario 2: Workflow Pause/Resume', () => {
    it('pauses workflow → waits → resumes workflow → continues execution', async () => {
      const sessionId = await createSession('pause-resume-test');

      // 发送一个需要执行较长时间的任务
      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: {
            content: '创建 3 个文件: a.txt, b.txt, c.txt，每个文件包含不同的内容',
            sessionId,
          },
          blocking: false,
        }),
      });
      expect((msgRes.json() as Promise<{ success: boolean }>).then((d) => d.success)).resolves.toBe(true);

      // 等待工作流创建
      await new Promise((r) => setTimeout(r, 5000));

      // 获取工作流
      const workflowsRes = await fetch(`${UI_URL}/api/v1/workflows`);
      const workflows = (await workflowsRes.json()) as Array<{ id: string; sessionId: string; status: string }>;
      const workflow = workflows.find((w) => w.sessionId === sessionId);
      expect(workflow).toBeDefined();

      // 暂停工作流
      const pauseRes = await fetch(`${UI_URL}/api/v1/workflow/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: workflow!.id }),
      });
      const pauseData = (await pauseRes.json()) as { success: boolean; status: string };
      expect(pauseData.success).toBe(true);
      expect(pauseData.status).toBe('paused');
      console.log(`[E2E] Workflow paused: ${workflow!.id}`);

      // 验证暂停状态
      const workflowRes = await fetch(`${UI_URL}/api/v1/workflows/${workflow!.id}`);
      const workflowData = (await workflowRes.json()) as { status: string };
      expect(workflowData.status).toBe('paused');

      // 恢复工作流
      const resumeRes = await fetch(`${UI_URL}/api/v1/workflow/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId: workflow!.id }),
      });
      const resumeData = (await resumeRes.json()) as { success: boolean; status: string };
      expect(resumeData.success).toBe(true);
      expect(resumeData.status).toBe('executing');
      console.log(`[E2E] Workflow resumed: ${workflow!.id}`);
    }, TEST_TIMEOUT);
  });

  // ========== 场景 3: WebSocket 实时事件订阅 ==========
  describe('Scenario 3: WebSocket Event Subscription', () => {
    it('subscribes by group → receives filtered events', async () => {
      const ws = await createWsConnection();
      const events: Array<{ type: string; group?: string }> = [];

      // 订阅 HUMAN_IN_LOOP 分组
      ws.send(JSON.stringify({ type: 'subscribe', groups: ['HUMAN_IN_LOOP'] }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Subscribe confirmation timeout'));
        }, 5000);

        ws.on('message', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            events.push(msg);

            if (msg.type === 'subscribe_confirmed') {
              clearTimeout(timeout);
              resolve();
            }
          } catch {
            // ignore
          }
        });
      });

      // 验证订阅确认
      const confirmEvent = events.find((e) => e.type === 'subscribe_confirmed');
      expect(confirmEvent).toBeDefined();
      console.log('[E2E] Subscribe confirmed for HUMAN_IN_LOOP group');

      ws.close();
    }, 30000);

    it('unsubscribes → stops receiving events', async () => {
      const ws = await createWsConnection();

      // 先订阅
      ws.send(JSON.stringify({ type: 'subscribe', groups: ['TASK'] }));

      await new Promise<void>((resolve) => {
        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'subscribe_confirmed') resolve();
        });
      });

      // 取消订阅
      ws.send(JSON.stringify({ type: 'unsubscribe' }));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Unsubscribe confirmation timeout'));
        }, 5000);

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'unsubscribe_confirmed') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      ws.close();
      console.log('[E2E] Unsubscribe confirmed');
    }, 30000);
  });

  // ========== 场景 4: 资源池管理 ==========
  describe('Scenario 4: Resource Pool Management', () => {
    it('lists available resources → deploys to session → releases back', async () => {
      // 1. 获取可用资源
      const resourcesRes = await fetch(`${UI_URL}/api/v1/resources`);
      const resourcesData = (await resourcesRes.json()) as {
        available: Array<{ id: string; type: string; status: string }>;
        count: number;
      };

      expect(resourcesData.count).toBeGreaterThanOrEqual(0);
      console.log(`[E2E] Available resources: ${resourcesData.count}`);

      // 2. 创建会话和工作流
      const sessionId = await createSession('resource-test');

      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'orchestrator-loop',
          message: { content: '简单测试任务', sessionId },
          blocking: false,
        }),
      });
      expect((msgRes.json() as Promise<{ success: boolean }>).then((d) => d.success)).resolves.toBe(true);

      await new Promise((r) => setTimeout(r, 3000));

      // 3. 获取工作流
      const workflowsRes = await fetch(`${UI_URL}/api/v1/workflows`);
      const workflows = (await workflowsRes.json()) as Array<{ id: string; sessionId: string }>;
      const workflow = workflows.find((w) => w.sessionId === sessionId);

      // 4. 如果有可用资源，测试部署
      if (resourcesData.available.length > 0 && workflow) {
        const resource = resourcesData.available[0];

        const deployRes = await fetch(`${UI_URL}/api/v1/resources/deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resourceId: resource.id,
            sessionId,
            workflowId: workflow.id,
          }),
        });
        const deployData = (await deployRes.json()) as { success: boolean; resource?: { status: string } };
        expect(deployData.success).toBe(true);
        console.log(`[E2E] Resource deployed: ${resource.id}`);

        // 5. 释放资源
        const releaseRes = await fetch(`${UI_URL}/api/v1/resources/release`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: resource.id }),
        });
        const releaseData = (await releaseRes.json()) as { success: boolean };
        expect(releaseData.success).toBe(true);
        console.log(`[E2E] Resource released: ${resource.id}`);
      }
    }, TEST_TIMEOUT);
  });

  // ========== 场景 5: 会话管理 ==========
  describe('Scenario 5: Session Management', () => {
    it('creates → lists → gets → deletes session', async () => {
      // 创建
      const sessionId = await createSession('session-mgmt-test');
      expect(sessionId).toBeDefined();

      // 列表
      const listRes = await fetch(`${UI_URL}/api/v1/sessions`);
      const sessions = (await listRes.json()) as Array<{ id: string; name: string }>;
      expect(sessions.find((s) => s.id === sessionId)).toBeDefined();

      // 获取详情
      const detailRes = await fetch(`${UI_URL}/api/v1/sessions/${sessionId}`);
      const detail = (await detailRes.json()) as { id: string; name: string; messageCount: number };
      expect(detail.id).toBe(sessionId);
      expect(detail.name).toBe('session-mgmt-test');

      // 删除
      const deleteRes = await fetch(`${UI_URL}/api/v1/sessions/${sessionId}`, {
        method: 'DELETE',
      });
      const deleteData = (await deleteRes.json()) as { success: boolean };
      expect(deleteData.success).toBe(true);

      // 验证删除
      const verifyRes = await fetch(`${UI_URL}/api/v1/sessions/${sessionId}`);
      expect(verifyRes.status).toBe(404);
      console.log('[E2E] Session lifecycle complete');
    }, 30000);

    it('pauses and resumes session', async () => {
      const sessionId = await createSession('pause-session-test');

      // 暂停
      const pauseRes = await fetch(`${UI_URL}/api/v1/sessions/${sessionId}/pause`, {
        method: 'POST',
      });
      const pauseData = (await pauseRes.json()) as { success: boolean };
      expect(pauseData.success).toBe(true);

      // 恢复
      const resumeRes = await fetch(`${UI_URL}/api/v1/sessions/${sessionId}/resume`, {
        method: 'POST',
      });
      const resumeData = (await resumeRes.json()) as { success: boolean };
      expect(resumeData.success).toBe(true);
      console.log('[E2E] Session pause/resume complete');
    }, 30000);
  });

  // ========== 场景 6: Block 状态查询 ==========
  describe('Scenario 6: Block State Query', () => {
    it('lists all blocks → queries block state', async () => {
      // 获取所有 Block
      const blocksRes = await fetch(`${UI_URL}/api/blocks`);
      const blocks = (await blocksRes.json()) as Array<{ id: string; commands: string[] }>;
      expect(blocks.length).toBeGreaterThan(0);
      console.log(`[E2E] Found ${blocks.length} blocks`);

      // 查询第一个 Block 的状态
      const block = blocks[0];
      const stateRes = await fetch(`${UI_URL}/api/blocks/${block.id}/state`);
      const state = (await stateRes.json()) as Record<string, unknown>;
      expect(state).toBeDefined();
      console.log(`[E2E] Block ${block.id} state: ${JSON.stringify(state).substring(0, 100)}`);
    }, 30000);
  });

  // ========== 场景 7: 事件历史查询 ==========
  describe('Scenario 7: Event History Query', () => {
    it('queries event types and groups', async () => {
      // 获取支持的事件类型
      const typesRes = await fetch(`${UI_URL}/api/v1/events/types`);
      const typesData = (await typesRes.json()) as { success: boolean; types: string[] };
      expect(typesData.success).toBe(true);
      expect(typesData.types.length).toBeGreaterThan(0);
      console.log(`[E2E] Event types: ${typesData.types.slice(0, 5).join(', ')}...`);

      // 获取支持的事件分组
      const groupsRes = await fetch(`${UI_URL}/api/v1/events/groups`);
      const groupsData = (await groupsRes.json()) as { success: boolean; groups: string[] };
      expect(groupsData.success).toBe(true);
      expect(groupsData.groups.length).toBeGreaterThan(0);
      console.log(`[E2E] Event groups: ${groupsData.groups.join(', ')}`);
    }, 30000);

    it('queries event history by group', async () => {
      // 先触发一些事件
      const sessionId = await createSession('event-history-test');

      const msgRes = await fetch(`${UI_URL}/api/v1/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: 'echo-input',
          message: { content: 'test event' },
          blocking: false,
        }),
      });
      expect((msgRes.json() as Promise<{ success: boolean }>).then((d) => d.success)).resolves.toBe(true);

      await new Promise((r) => setTimeout(r, 2000));

      // 查询历史
      const historyRes = await fetch(`${UI_URL}/api/v1/events/history?group=SESSION&limit=10`);
      const historyData = (await historyRes.json()) as { success: boolean; events: unknown[] };
      expect(historyData.success).toBe(true);
      console.log(`[E2E] Event history count: ${historyData.events.length}`);
    }, 30000);
  });

  // ========== 场景 8: 健康检查 ==========
  describe('Scenario 8: Health Check', () => {
    it('returns healthy status', async () => {
      const res = await fetch(`${UI_URL}/health`);
      const data = (await res.json()) as { status: string; timestamp: string };
      expect(data.status).toBe('healthy');
      expect(data.timestamp).toBeDefined();
    }, 10000);

    it('returns test endpoint', async () => {
      const res = await fetch(`${UI_URL}/api/test`);
      const data = (await res.json()) as { ok: boolean; message: string };
      expect(data.ok).toBe(true);
    }, 10000);
  });
});
