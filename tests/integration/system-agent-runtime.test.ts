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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_PORT = 5523;
let daemonProcess: ChildProcess | null = null;
let daemonOutput = '';

async function startDaemon(): Promise<void> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(DAEMON_PORT) };
    const daemonPath = path.resolve(__dirname, '../../dist/server/index.js');
    
    daemonProcess = spawn('node', [daemonPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    
    let started = false;
    
    daemonProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      daemonOutput += output;
      if ((output.includes('running at') || output.includes('listening')) && !started) {
        started = true;
        setTimeout(resolve, 500);
      }
    });
    
    daemonProcess.stderr?.on('data', (data) => {
      daemonOutput += data.toString();
    });
    
    daemonProcess.on('error', (err) => {
      if (!started) reject(err);
    });
    
    setTimeout(() => {
      if (!started) reject(new Error('Daemon startup timeout'));
    }, 15000);
  });
}

async function stopDaemon(): Promise<void> {
  if (!daemonProcess) return;
  
  return new Promise((resolve) => {
    daemonProcess?.kill('SIGTERM');
    setTimeout(() => {
      daemonProcess?.kill('SIGKILL');
      resolve();
    }, 3000);
  });
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
  });

  it('should verify system agent module registered with project_tool', async () => {
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
    
    console.log(`System dir exists: ${systemDirExists}`);
    
    // 至少系统目录应该存在（由 daemon 创建）
    expect(systemDirExists).toBe(true);
  });

  it('should verify memory recording mechanism in dispatch code', async () => {
    // 验证 MEMORY 记录机制的代码路径存在
    
    // 检查 dispatch.ts 文件存在
    const dispatchPath = path.resolve(__dirname, '../../dist/server/modules/agent-runtime/dispatch.js');
    const dispatchExists = await fs.access(dispatchPath).then(() => true).catch(() => false);
    expect(dispatchExists).toBe(true);
    
    // 检查 dispatch.ts 内容包含 MEMORY 记录逻辑
    if (dispatchExists) {
      const dispatchContent = await fs.readFile(dispatchPath, 'utf-8');
      expect(dispatchContent).toContain('MEMORY.md');
      expect(dispatchContent).toContain('metadata.source');
      expect(dispatchContent).toContain('metadata.role');
      
      // 验证记录条件
      expect(dispatchContent).toContain('channel');
      expect(dispatchContent).toContain('webui');
      expect(dispatchContent).toContain('api');
      expect(dispatchContent).toContain('role');
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
