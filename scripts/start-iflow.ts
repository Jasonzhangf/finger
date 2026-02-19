/**
 * iFlow 服务启动脚本
 * 使用 SDK 自动管理 iFlow 进程
 */

import { IFlowClient, TransportMode } from '@iflow-ai/iflow-cli-sdk';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IFLOW_PORT = process.env.IFLOW_PORT ? parseInt(process.env.IFLOW_PORT, 10) : 8090;
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || join(__dirname, '..', 'output', 'deepseek-research');

async function startIFlow(): Promise<{ client: IFlowClient; pid?: number }> {
  console.log('[iFlow] Starting iFlow service...');
  console.log(`[iFlow] Workspace: ${WORKSPACE_DIR}`);
  
  // 确保工作目录存在
  const fs = await import('fs/promises');
  try {
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  } catch { /* ignore */ }

  // 使用 SDK 自动启动 iFlow 进程
  const client = new IFlowClient({
    url: `ws://localhost:${IFLOW_PORT}/acp`,
    cwd: WORKSPACE_DIR,
    autoStartProcess: true,  // 自动启动 iFlow 进程
    processStartPort: IFLOW_PORT,
    transportMode: TransportMode.WEBSOCKET,
    sessionSettings: {
      system_prompt: '你是一个专业的 AI 研究助手，擅长技术调研和报告撰写。',
      allowed_tools: ['web_search', 'read_file', 'write_file', 'execute_command'],
      max_turns: 50,
    },
    permissionMode: 'auto',  // 自动批准工具调用
  });

  try {
    await client.connect();
    console.log('[iFlow] Connected successfully');
    console.log(`[iFlow] Session ID: ${client.getSessionId()}`);
    
    // 获取可用模型
    const models = await client.config.get<{ availableModels?: Array<{ id: string; name: string }> }>('models');
    if (models?.availableModels?.length) {
      console.log(`[iFlow] Available models: ${models.availableModels.map(m => m.id).join(', ')}`);
    }
    
    return { client };
  } catch (err) {
    console.error('[iFlow] Failed to start:', err);
    throw err;
  }
}

async function main() {
  try {
    const { client } = await startIFlow();
    
    // 保持进程运行
    console.log('[iFlow] Service is running. Press Ctrl+C to stop.');
    
    // 处理退出信号
    process.on('SIGINT', async () => {
      console.log('\n[iFlow] Shutting down...');
      await client.disconnect();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('\n[iFlow] Shutting down...');
      await client.disconnect();
      process.exit(0);
    });
    
    // 保持运行
    await new Promise(() => {});
  } catch (err) {
    console.error('[iFlow] Startup failed:', err);
    process.exit(1);
  }
}

main();
