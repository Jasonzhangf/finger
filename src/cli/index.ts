#!/usr/bin/env node
/**
 * Finger CLI - Main Entry Point
 * 
 * Registers all CLI commands for the myfinger CLI tool
 */

import { Command } from 'commander';
import { configureAgentCommandUrls, understandCommand, routeCommand, planCommand, executeCommand, reviewCommand, orchestrateCommand, dryrunCommand } from './agent-commands.js';
import { registerDaemonCommand } from './daemon.js';
import { registerChatCommand } from './chat-mode.js';
import { registerChatCodexCommand } from './chat-codex.js';
import { registerSessionPanelCommand } from './session-panel.js';
import { registerTuiCommand } from './tui.js';
import { loadDynamicCliPlugins, registerPluginCommand } from './plugin-loader.js';
import { registerCapabilityCommand, registerCliCapabilityAliases } from './cli-capability-loader.js';
import { registerToolCommand } from './tool-command.js';
import { registerGatewayCommand } from './gateway-command.js';
import { registerGatewayWorkerCommand } from './gateway-worker.js';
import { registerOpenClawGatewayBridgeCommand } from './openclaw-gateway-bridge.js';
import { registerOpenClawIntegrationCommand } from './openclaw-integration.js';
import { registerFingerShortcuts } from './finger-shortcuts.js';
import { registerInitCommand } from './init.js';
import { registerMemoryLedgerCommand } from './memory-ledger.js';
import { registerTestCommand } from './test-command.js';
import { registerCommandHubCommand } from './command-hub.js';
import { registerMailboxCommand } from './mailbox.js';
import { ensureFingerLayout, FINGER_PATHS } from '../core/finger-paths.js';
import { getFingerAppVersion } from '../core/app-version.js';
import { DualDaemonSupervisor, enableAutoStart, disableAutoStart } from '../daemon/dual-daemon.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const clog = createConsoleLikeLogger('Index');
const CLI_VERSION = getFingerAppVersion();

const DEFAULT_HTTP_BASE_URL = process.env.FINGER_HTTP_URL || process.env.FINGER_HUB_URL || 'http://localhost:9999';
const DEFAULT_WS_URL = process.env.FINGER_WS_URL || 'ws://localhost:9998';

// Ensure Finger layout exists
ensureFingerLayout();

function readPidFromRuntimeFile(fileName: string): number | null {
  const filePath = join(FINGER_PATHS.runtime.dir, fileName);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number | null): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probePrimaryRuntimeHealth(): Promise<{
  url: string;
  ok: boolean;
  status?: number;
  payload?: unknown;
  error?: string;
}> {
  const url = process.env.FINGER_PRIMARY_HEALTH_URL || 'http://127.0.0.1:5520/health';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    const status = response.status;
    let payload: unknown = undefined;
    try {
      payload = await response.json();
    } catch {
      // keep payload undefined
    }
    return {
      url,
      ok: response.ok,
      status,
      payload,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  // Backward-compatible fingerdaemon flags:
  //   fingerdaemon --start|--stop|--status|--enable-autostart|--disable-autostart
  // These flags are historically used by ops scripts. Handle them before commander parsing
  // to avoid "unknown option '--start'" and ensure deterministic daemon control behavior.
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length > 0 && rawArgs[0].startsWith('--')) {
    const cmd = rawArgs[0];
    const supervisor = new DualDaemonSupervisor();
    if (cmd === '--start') {
      await supervisor.start();
      return;
    }
    if (cmd === '--stop') {
      await supervisor.stop();
      return;
    }
    if (cmd === '--status') {
      const dual = supervisor.getStatus();
      const guardPid = readPidFromRuntimeFile('guard.pid');
      const serverPid = readPidFromRuntimeFile('server.pid');
      const guardAlive = isPidAlive(guardPid);
      const serverAlive = isPidAlive(serverPid);
      const primaryHealth = await probePrimaryRuntimeHealth();
      const primaryRunning = guardAlive || serverAlive || primaryHealth.ok;
      const merged = {
        ...dual,
        running: dual.running || primaryRunning,
        primaryRuntime: {
          running: primaryRunning,
          guard: {
            pid: guardPid,
            alive: guardAlive,
          },
          server: {
            pid: serverPid,
            alive: serverAlive,
          },
          health: primaryHealth,
        },
      };
      clog.log(JSON.stringify(merged, null, 2));
      return;
    }
    if (cmd === '--enable-autostart') {
      enableAutoStart();
      return;
    }
    if (cmd === '--disable-autostart') {
      disableAutoStart();
      return;
    }
  }

  const program = new Command();

  program
    .name('myfinger')
    .description('AI Agent 编排系统 CLI')
    .version(CLI_VERSION)
    .option('--base-url <url>', 'Message Hub base URL', DEFAULT_HTTP_BASE_URL)
    .option('--ws-url <url>', 'WebSocket base URL', DEFAULT_WS_URL);

  program.hook('preAction', (command) => {
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
    .action(async (input, options) => {
      try {
        await understandCommand(input, { sessionId: options.session });
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  program
    .command('route')
    .description('路由决策：基于语义分析结果决定任务流向')
    .option('-i, --intent <json>', '语义分析结果 JSON')
    .option('-s, --session <id>', '会话 ID')
    .action(async (options) => {
      try {
        if (!options.intent) {
          clog.error('[CLI Error] Missing --intent option');
          process.exit(1);
        }
        await routeCommand(options.intent, { sessionId: options.session });
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  program
    .command('plan')
    .description('任务规划：将大任务拆解为可执行子任务')
    .argument('<task>', '任务描述')
    .option('-s, --session <id>', '会话 ID')
    .action(async (task, options) => {
      try {
        await planCommand(task, { sessionId: options.session });
      } catch (error) {
        clog.error('[CLI Error]', error);
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
    .action(async (options) => {
      try {
        if (!options.task) {
          clog.error('[CLI Error] Missing --task option');
          process.exit(1);
        }
        await executeCommand(options.task, {
          agent: options.agent,
          blocking: options.blocking,
          sessionId: options.session,
        });
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  program
    .command('review')
    .description('质量审查：审查计划和执行结果')
    .option('-p, --proposal <json>', '待审查的方案 JSON')
    .action(async (options) => {
      try {
        if (!options.proposal) {
          clog.error('[CLI Error] Missing --proposal option');
          process.exit(1);
        }
        await reviewCommand(options.proposal);
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  program
    .command('orchestrate')
    .description('编排协调：管理整体任务流程')
    .argument('<task>', '任务描述')
    .option('-s, --session <id>', '会话 ID')
    .option('-w, --watch', '监视模式（持续输出事件）')
    .action(async (task, options) => {
      try {
        await orchestrateCommand(task, {
          sessionId: options.session,
          watch: options.watch,
        });
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  program
    .command('dryrun')
    .description('Dryrun：仅构建注入请求，不触发模型调用')
    .argument('<text>', '输入文本')
    .option('-t, --target <id>', '目标 Agent/模块 ID')
    .option('-s, --session <id>', '会话 ID')
    .option('-r, --role-profile <profile>', '角色 profile')
    .action(async (text, options) => {
      try {
        await dryrunCommand(text, {
          target: options.target,
          sessionId: options.session,
          roleProfile: options.roleProfile,
        });
      } catch (error) {
        clog.error('[CLI Error]', error);
        process.exit(1);
      }
    });

  // ========== Register Core Commands ==========
  registerDaemonCommand(program);
  registerChatCommand(program);
  registerChatCodexCommand(program);
  registerSessionPanelCommand(program);
  registerTuiCommand(program);
  registerPluginCommand(program);
  registerCapabilityCommand(program);
  registerToolCommand(program);
  registerGatewayCommand(program);
  registerGatewayWorkerCommand(program);
  registerOpenClawGatewayBridgeCommand(program);
  registerOpenClawIntegrationCommand(program);
  registerMemoryLedgerCommand(program);
  registerTestCommand(program);
  registerCommandHubCommand(program);
  registerMailboxCommand(program);
  registerInitCommand(program);
  registerFingerShortcuts(program);

  // ========== Register Dynamic Plugins ==========
  await loadDynamicCliPlugins(program, {
    defaultHttpBaseUrl: DEFAULT_HTTP_BASE_URL,
    defaultWsUrl: DEFAULT_WS_URL,
    cliVersion: CLI_VERSION,
  });

  // ========== Register CLI Capability Aliases ==========
  await registerCliCapabilityAliases(program);

  // ========== Parse and Execute ==========
  program.parse(process.argv);
}

main().catch((error) => {
  clog.error('[CLI Error] Failed to start CLI:', error);
  process.exit(1);
});
