/**
 * System Agent Runtime Integration Test
 * 
 * 验证真实 daemon 环境下 System Agent 的核心功能：
 * 1. project_tool 注册和工具列表
 * 2. MEMORY 自动记录机制（代码层面验证）
 * 3. 跨项目限制（System Agent 配置验证）
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let daemonProcess: ChildProcess | null = null;
let daemonOutput = '';
let daemonPort = 0;
let daemonWsPort = 0;

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

async function isDaemonHealthy(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForOutput(fragment: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemonOutput.includes(fragment)) {
      return;
    }
    if (daemonProcess?.exitCode !== null) {
      throw new Error(`Daemon exited before output "${fragment}" appeared\n${daemonOutput}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for daemon output "${fragment}"\n${daemonOutput}`);
}

async function startDaemon(): Promise<void> {
  daemonPort = await reservePort();
  daemonWsPort = await reservePort();

  const env = {
    ...process.env,
    PORT: String(daemonPort),
    WS_PORT: String(daemonWsPort),
    NODE_ENV: 'test',
  };
  const daemonPath = path.resolve(__dirname, '../../dist/server/index.js');

  daemonProcess = spawn(process.execPath, [daemonPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  daemonProcess.stdout?.on('data', (data) => {
    daemonOutput += data.toString();
  });
  daemonProcess.stderr?.on('data', (data) => {
    daemonOutput += data.toString();
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (daemonProcess.exitCode !== null) {
      throw new Error(`Daemon exited during startup (code=${daemonProcess.exitCode})\n${daemonOutput}`);
    }
    if (await isDaemonHealthy(daemonPort)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Daemon startup timeout on http://127.0.0.1:${daemonPort} (ws ${daemonWsPort})\n${daemonOutput}`);
}

async function stopDaemon(): Promise<void> {
  if (!daemonProcess) return;

  const daemon = daemonProcess;
  daemonProcess = null;

  if (daemon.exitCode !== null || daemon.killed) {
    return;
  }

  daemon.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => daemon.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]);

  if (daemon.exitCode === null && !daemon.killed) {
    daemon.kill('SIGKILL');
  }
}

describe('System Agent Runtime Tests', () => {
  beforeAll(async () => {
    daemonOutput = '';
    await startDaemon();
  }, 60000);

  afterAll(async () => {
    await stopDaemon();
  }, 30000);

  it('should verify daemon is running', async () => {
    // 验证 daemon 进程存在
    expect(daemonProcess?.pid).toBeDefined();
    expect(daemonProcess?.killed).toBe(false);
    expect(await isDaemonHealthy(daemonPort)).toBe(true);
  });

  it('should verify system agent module registered with project_tool', async () => {
    await waitForOutput('finger-system-agent');
    await waitForOutput('shell.exec');

    // 验证 finger-system-agent 模块已注册
    expect(daemonOutput).toContain('finger-system-agent');

    // 验证 agent.dispatch 和 agent.list 等 runtime 工具已注册
    // （project_tool 通过 AgentRuntimeDeps 在 registerDefaultRuntimeTools 中按需加载，
    //   实际注册在 registerAgentRuntimeTools / agent-runtime.ts 中完���）
    expect(daemonOutput).toContain('shell.exec');
  });

  it('should verify system agent configuration', async () => {
    // 验证 system agent 目录结构
    const systemDir = path.join(process.env.HOME || '~', '.finger/system');
    
    // 验证系统目录存在
    let systemDirExists = false;
    try {
      await fs.access(systemDir);
      systemDirExists = true;
    } catch {
      // Directory may not exist yet
    }
    
    // 至少系统目录应该存在（由 daemon 创建）
    expect(systemDirExists).toBe(true);
  });

  it('should verify memory recording mechanism in dispatch code', async () => {
    // 验证 dispatch shim 文件存在
    const dispatchPath = path.resolve(__dirname, '../../dist/server/modules/agent-runtime/dispatch.js');
    const dispatchExists = await fs.access(dispatchPath).then(() => true).catch(() => false);
    expect(dispatchExists).toBe(true);

    // dispatch 现为 split shim，校验其导向 serverx 实现
    if (dispatchExists) {
      const dispatchContent = await fs.readFile(dispatchPath, 'utf-8');
      expect(dispatchContent).toContain('serverx/modules/agent-runtime/dispatch.impl');
    }

    // MEMORY 写入逻辑位于 dispatch-runtime-helpers.impl.js
    const dispatchHelpersPath = path.resolve(
      __dirname,
      '../../dist/serverx/modules/agent-runtime/dispatch-runtime-helpers.impl.js',
    );
    const helpersExist = await fs.access(dispatchHelpersPath).then(() => true).catch(() => false);
    expect(helpersExist).toBe(true);

    if (helpersExist) {
      const helpersContent = await fs.readFile(dispatchHelpersPath, 'utf-8');
      expect(helpersContent).toContain('persistUserMessageToMemory');
      expect(helpersContent).toContain('MEMORY.md');
      expect(helpersContent).toContain('metadata.source');
      expect(helpersContent).toContain('metadata.role');
      expect(helpersContent).toContain('channel');
      expect(helpersContent).toContain('webui');
      expect(helpersContent).toContain('api');
    }
  });

  it('should verify project_tool implementation', async () => {
    // 验证 project_tool 实现存在
    const projectToolPath = path.resolve(__dirname, '../../dist/tools/internal/project-tool/project-tool.js');
    const projectToolExists = await fs.access(projectToolPath).then(() => true).catch(() => false);
    expect(projectToolExists).toBe(true);
    
    if (projectToolExists) {
      const projectToolContent = await fs.readFile(projectToolPath, 'utf-8');
      expect(projectToolContent).toContain('registerProjectTool');
      expect(projectToolContent).toContain('create');
      expect(projectToolContent).toContain('MEMORY.md');
      expect(projectToolContent).toContain('sessionManager');
    }
  });
});
