#!/usr/bin/env node
/**
 * Finger CLI
 */

import { Command } from 'commander';
import {
  configureAgentCommandUrls,
  understandCommand,
  routeCommand,
  planCommand,
  executeCommand,
  reviewCommand,
  orchestrateCommand,
} from './agent-commands.js';
import { registerDaemonCommand } from './daemon.js';
import { registerChatCommand } from './chat-mode.js';
import { registerChatCodexCommand } from './chat-codex.js';
import { registerSessionPanelCommand } from './session-panel.js';
import { registerIflowCommand } from './iflow.js';
import { loadDynamicCliPlugins, registerPluginCommand } from './plugin-loader.js';
import { registerCapabilityCommand, registerCliCapabilityAliases } from './cli-capability-loader.js';
import { registerToolCommand } from './tool-command.js';
import { registerGatewayCommand } from './gateway-command.js';
import { registerGatewayWorkerCommand } from './gateway-worker.js';
import { registerMemoryLedgerCommand } from './memory-ledger.js';
import { ensureFingerLayout } from '../core/finger-paths.js';

const DEFAULT_HTTP_BASE_URL = process.env.FINGER_HTTP_URL || process.env.FINGER_HUB_URL || 'http://localhost:5521';
const DEFAULT_WS_URL = process.env.FINGER_WS_URL || 'ws://localhost:5522';

ensureFingerLayout();

const program = new Command();

program
  .name('finger')
  .description('AI Agent 编排系统 CLI')
  .version('1.0.0')
  .option('--base-url <url>', 'Message Hub base URL', DEFAULT_HTTP_BASE_URL)
  .option('--ws-url <url>', 'WebSocket base URL', DEFAULT_WS_URL)
  .hook('preAction', (command) => {
    const options = command.opts();
    configureAgentCommandUrls({
      hubUrl: options.baseUrl,
      wsUrl: options.wsUrl,
    });
  });

// ========== Agent Commands ==========
program
  .command('understand')
  .description('语义理解：分析用户输入意图')
  .argument('<input>', '用户输入文本')
  .option('-s, --session <id>', '会话 ID')
  .action(async (input: string, options: { session?: string }) => {
    try {
      await understandCommand(input, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('route')
  .description('路由决策：基于语义分析结果决定任务流向')
  .option('-i, --intent <json>', '语义分析结果 JSON')
  .option('-s, --session <id>', '会话 ID')
  .action(async (options: { intent?: string; session?: string }) => {
    try {
      if (!options.intent) {
        console.error('[CLI Error] Missing --intent option');
        process.exit(1);
      }
      await routeCommand(options.intent, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('任务规划：将大任务拆解为可执行子任务')
  .argument('<task>', '任务描述')
  .option('-s, --session <id>', '会话 ID')
  .action(async (task: string, options: { session?: string }) => {
    try {
      await planCommand(task, { sessionId: options.session });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('execute')
  .description('任务执行：调用工具完成具体任务')
  .option('-t, --task <description>', '任务描述')
  .option('-a, --agent <id>', '执行 Agent ID')
  .option('-b, --blocking', '阻塞模式（等待结果）')
  .option('-s, --session <id>', '会话 ID')
  .action(async (options: { task?: string; agent?: string; blocking?: boolean; session?: string }) => {
    try {
      if (!options.task) {
        console.error('[CLI Error] Missing --task option');
        process.exit(1);
      }
      await executeCommand(options.task, {
        agent: options.agent,
        blocking: options.blocking,
        sessionId: options.session,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('review')
  .description('质量审查：审查计划和执行结果')
  .option('-p, --proposal <json>', '待审查的方案 JSON')
  .action(async (options: { proposal?: string }) => {
    try {
      if (!options.proposal) {
        console.error('[CLI Error] Missing --proposal option');
        process.exit(1);
      }
      await reviewCommand(options.proposal);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('orchestrate')
  .description('编排协调：管理整体任务流程')
  .argument('<task>', '任务描述')
  .option('-s, --session <id>', '会话 ID')
  .option('-w, --watch', '监视模式（持续输出事件）')
  .action(async (task: string, options: { session?: string; watch?: boolean }) => {
    try {
      await orchestrateCommand(task, {
        sessionId: options.session,
        watch: options.watch,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Workflow Commands ==========
program
  .command('list')
  .description('列出所有工作流状态')
  .action(async () => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/workflows/state`);
      if (!res.ok) {
        throw new Error(`Failed to list workflows: ${res.statusText}`);
      }
      const { snapshots } = await res.json() as { snapshots: Array<{ workflowId: string; fsmState: string; simplifiedStatus: string }> };
      snapshots.forEach((s) => {
        console.log(`- ${s.workflowId}: ${s.fsmState} (${s.simplifiedStatus})`);
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('pause')
  .description('暂停工作流')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/workflow/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      });
      const result = await res.json();
      console.log('Workflow paused:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('resume')
  .description('恢复工作流')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/workflow/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      });
      const result = await res.json();
      console.log('Workflow resumed:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('cancel')
  .description('取消工作流')
  .argument('<workflowId>', '工作流 ID')
  .action(async (workflowId: string) => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/workflows/${workflowId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await res.json();
      console.log('Workflow cancelled:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('input')
  .description('发送用户输入到工作流')
  .argument('<workflowId>', '工作流 ID')
  .argument('<input>', '输入内容')
  .action(async (workflowId: string, input: string) => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/workflow/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflowId, input }),
      });
      const result = await res.json();
      console.log('Input sent:', result);
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// ========== Runtime Commands ==========
program
  .command('agents')
  .description('列出所有 Agent')
  .action(async () => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/agents`);
      if (!res.ok) {
        throw new Error(`Failed to list agents: ${res.statusText}`);
      }
      const agents = await res.json() as Array<{ id: string; status: string; type?: string }>;
      agents.forEach((a) => {
        console.log(`- ${a.id}: ${a.status} (${a.type || 'agent'})`);
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('resources')
  .description('列出资源池状态')
  .action(async () => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/resources`);
      if (!res.ok) {
        throw new Error(`Failed to list resources: ${res.statusText}`);
      }
      const payload = await res.json() as { available: Array<{ id: string; status: string; type?: string }>; count: number };
      console.log(`Available Resources (${payload.count}):`);
      payload.available.forEach((r) => {
        console.log(`- ${r.id}: ${r.status} (${r.type || 'resource'})`);
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('events')
  .description('订阅工作流事件（实时流）')
  .argument('<workflowId>', '工作流 ID')
  .option('-t, --types <types>', '事件类型（逗号分隔）')
  .action(async (workflowId: string, options: { types?: string }) => {
    try {
      const WebSocket = (await import('ws')).default;
      const ws = new WebSocket(DEFAULT_WS_URL);

      ws.on('open', () => {
        console.log(`Connected. Subscribing to workflow ${workflowId}...`);
        ws.send(JSON.stringify({
          type: 'subscribe',
          workflowId,
          types: options.types ? options.types.split(',') : ['*'],
        }));
      });

      ws.on('message', (data: { toString(): string }) => {
        const event = JSON.parse(data.toString()) as { type: string; payload?: unknown; timestamp?: string };
        const timestamp = new Date(event.timestamp || Date.now()).toLocaleTimeString();
        console.log(`[${timestamp}] ${event.type}: ${JSON.stringify(event.payload)}`);
      });

      ws.on('error', (err: Error) => {
        console.error('WebSocket error:', err.message);
        process.exit(1);
      });

      ws.on('close', () => {
        console.log('Connection closed');
        process.exit(0);
      });

      process.on('SIGINT', () => ws.close());
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('sessions')
  .description('列出会话')
  .action(async () => {
    try {
      const res = await fetch(`${DEFAULT_HTTP_BASE_URL}/api/v1/sessions`);
      if (!res.ok) {
        throw new Error(`Failed to list sessions: ${res.statusText}`);
      }
      const sessions = await res.json() as Array<{ id: string; name?: string; status?: string }>;
      sessions.forEach((s) => {
        console.log(`- ${s.id}: ${s.name || 'unnamed'} (${s.status || 'active'})`);
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

program
  .command('repl')
  .description('交互式模式：实时对话和任务管理')
  .option('--http-url <url>', 'HTTP API URL', DEFAULT_HTTP_BASE_URL)
  .option('--ws-url <url>', 'WebSocket URL', DEFAULT_WS_URL)
  .action(async (options: { httpUrl: string; wsUrl: string }) => {
    try {
      const { startREPL } = await import('./repl.js');
      await startREPL({
        httpUrl: options.httpUrl,
        wsUrl: options.wsUrl,
      });
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

// daemon 子命令
registerDaemonCommand(program);
registerChatCommand(program);
registerChatCodexCommand(program);
registerSessionPanelCommand(program);
registerIflowCommand(program);
registerPluginCommand(program);
registerCapabilityCommand(program);
registerToolCommand(program);
registerGatewayCommand(program);
registerGatewayWorkerCommand(program);
registerMemoryLedgerCommand(program);

// ========== Status Command (via Mailbox) ==========
program
  .command('status')
  .description('查看消息/工作流状态 (通过 callbackId 或 messageId)')
  .argument('<id>', 'callbackId 或 messageId')
  .option('-j, --json', 'JSON 输出')
  .option('-f, --follow', '持续监听状态变更')
  .action(async (id: string, options: { json?: boolean; follow?: boolean }) => {
    try {
      const MESSAGE_HUB_URL = process.env.FINGER_HUB_URL || DEFAULT_HTTP_BASE_URL;
      
      // 优先尝试 callbackId 查询
      let res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/callback/${id}`);
      
      // 如果 callbackId 不存在，回退到 messageId 查询
      if (res.status === 404) {
        res = await fetch(`${MESSAGE_HUB_URL}/api/v1/mailbox/${id}`);
      }
      
      if (res.status === 404) {
        console.error(`[CLI Error] Message not found: ${id}`);
        console.error('[CLI] Hint: Use mailbox list to see available messages');
        process.exit(1);
      }
      
      if (!res.ok) {
        throw new Error(`Failed to get status: ${res.statusText}`);
      }
      
      const data = await res.json();
      
      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`\nMessage Status: ${data.id}`);
        console.log('-'.repeat(50));
        console.log(`Target:   ${data.target}`);
        console.log(`Status:   ${data.status}`);
        console.log(`Created:  ${new Date(data.createdAt).toLocaleString()}`);
        console.log(`Updated:  ${new Date(data.updatedAt).toLocaleString()}`);
        
        if (data.callbackId) {
          console.log(`Callback: ${data.callbackId}`);
        }
        
        if (data.result) {
          console.log('\nResult:');
          console.log(JSON.stringify(data.result, null, 2));
        }
        
        if (data.error) {
          console.log('\nError:');
          console.log(data.error);
        }
      }
      
      // --follow 模式: 通过 WebSocket 监听状态变更
      if (options.follow && data.status !== 'completed' && data.status !== 'failed') {
        const WebSocket = (await import('ws')).default;
        const ws = new WebSocket(DEFAULT_WS_URL);
        
        console.log('\n[CLI] Listening for status updates... (Ctrl+C to stop)');
        
        ws.on('open', () => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            messageId: id,
          }));
        });
        
        ws.on('message', (rawData: { toString(): string }) => {
          const msg = JSON.parse(rawData.toString());
          if (msg.type === 'messageUpdate' && msg.message?.id === id) {
            const m = msg.message;
            console.log(`[${new Date().toLocaleTimeString()}] Status: ${m.status}`);
            
            if (m.status === 'completed') {
              console.log('Result:', JSON.stringify(m.result, null, 2));
              ws.close();
              process.exit(0);
            }
            if (m.status === 'failed') {
              console.error('Error:', m.error);
              ws.close();
              process.exit(1);
            }
          }
        });
        
        ws.on('error', (err: Error) => {
          console.error('[CLI] WebSocket error:', err.message);
          process.exit(1);
        });
        
        process.on('SIGINT', () => ws.close());
      }
    } catch (error) {
      console.error('[CLI Error]', error);
      process.exit(1);
    }
  });

const pluginLoadResult = await loadDynamicCliPlugins(program, {
  defaultHttpBaseUrl: DEFAULT_HTTP_BASE_URL,
  defaultWsUrl: DEFAULT_WS_URL,
  cliVersion: program.version() || '1.0.0',
});

if (pluginLoadResult.loaded.length > 0) {
  console.log(`[CLI Plugin] Loaded: ${pluginLoadResult.loaded.join(', ')}`);
}

const capabilityAliasResult = await registerCliCapabilityAliases(program, {
  daemonUrl: DEFAULT_HTTP_BASE_URL,
});
if (capabilityAliasResult.loaded.length > 0) {
  console.log(`[Capability] Loaded CLI aliases: ${capabilityAliasResult.loaded.join(', ')}`);
}

program.parse();
