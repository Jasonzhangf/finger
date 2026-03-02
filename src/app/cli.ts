/**
 * App CLI - 交互式入口
 * 支持交互模式和非交互模式
 */

import * as readline from 'readline';
import { SessionManager } from '../orchestration/session-manager.js';
import { MessageHub } from '../orchestration/message-hub.js';
import { ModuleRegistry } from '../orchestration/module-registry.js';
import { globalEventBus } from '../runtime/event-bus.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { RuntimeFacade } from '../runtime/runtime-facade.js';
import { registerDefaultRuntimeTools } from '../runtime/default-tools.js';
import {
  createFingerGeneralModule,
  FINGER_ORCHESTRATOR_AGENT_ID,
  FINGER_RESEARCHER_AGENT_ID,
  FINGER_EXECUTOR_AGENT_ID,
  FINGER_CODER_AGENT_ID,
  FINGER_REVIEWER_AGENT_ID,
} from '../agents/finger-general/finger-general-module.js';
import type { RuntimeEvent } from '../runtime/events.js';

export interface AppCLIOptions {
  interactive?: boolean;
  prompt?: string;
  projectPath?: string;
  sessionId?: string;
}

let currentSessionId: string | null = null;
let sessionManager: SessionManager | null = null;
let runtime: RuntimeFacade | null = null;
let rl: readline.Interface | null = null;
let hub: MessageHub | null = null;
let moduleRegistry: ModuleRegistry | null = null;

/**
 * 运行 App CLI
 */
export async function runAppCLI(args: string[]): Promise<void> {
  const options = parseArgs(args);

  // 初始化
  sessionManager = new SessionManager();
  hub = new MessageHub();
  moduleRegistry = new ModuleRegistry(hub);
  runtime = new RuntimeFacade(globalEventBus, sessionManager, globalToolRegistry);
  registerDefaultRuntimeTools(globalToolRegistry);

  const modules = [
    createFingerGeneralModule({ id: FINGER_ORCHESTRATOR_AGENT_ID, roleProfile: 'orchestrator' }),
    createFingerGeneralModule({ id: FINGER_RESEARCHER_AGENT_ID, roleProfile: 'researcher' }),
    createFingerGeneralModule({ id: FINGER_EXECUTOR_AGENT_ID, roleProfile: 'executor' }),
    createFingerGeneralModule({ id: FINGER_CODER_AGENT_ID, roleProfile: 'coder' }),
    createFingerGeneralModule({ id: FINGER_REVIEWER_AGENT_ID, roleProfile: 'reviewer' }),
  ];
  for (const module of modules) {
    await moduleRegistry.register(module);
  }

  console.log('[App] Finger role modules ready: finger-orchestrator, finger-researcher, finger-executor, finger-coder, finger-reviewer');

  // 订阅事件打印
  globalEventBus.subscribeAll(printEvent);

  // 恢复或创建会话
  if (options.sessionId) {
    const session = sessionManager.getSession(options.sessionId);
    if (session) {
      currentSessionId = session.id;
      console.log(`[App] Resumed session: ${session.name}`);
    } else {
      console.error(`[App] Session not found: ${options.sessionId}`);
      process.exit(1);
    }
  } else {
    const current = sessionManager.getCurrentSession();
    if (current) {
      currentSessionId = current.id;
      console.log(`[App] Auto-resumed session: ${current.name}`);
    } else {
      const projectPath = options.projectPath || process.cwd();
      const session = sessionManager.createSession(projectPath, 'New Session');
      currentSessionId = session.id;
      console.log(`[App] Created session: ${session.name}`);
    }
  }

  if (options.prompt) {
    // 非交互模式：执行单个 prompt
    await executePrompt(options.prompt);
  } else if (options.interactive || !options.prompt) {
    // 交互模式
    await startInteractiveMode();
  }
}

/**
 * 解析命令行参数
 */
function parseArgs(args: string[]): AppCLIOptions {
  const options: AppCLIOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-i' || arg === '--interactive') {
      options.interactive = true;
    } else if (arg === '-p' || arg === '--prompt') {
      options.prompt = args[++i];
    } else if (arg === '--project') {
      options.projectPath = args[++i];
    } else if (arg === '-s' || arg === '--session') {
      options.sessionId = args[++i];
    }
  }

  return options;
}

/**
 * 执行单个 prompt
 */
async function executePrompt(prompt: string): Promise<void> {
  if (!runtime || !currentSessionId || !hub) return;

  console.log(`\n> ${prompt}\n`);
  await runtime.sendMessage(currentSessionId, prompt);

  // 通过 MessageHub 发送任务给 finger-orchestrator
  try {
    console.log('[App] Sending task to finger-orchestrator...');
    const result = await hub.sendToModule(FINGER_ORCHESTRATOR_AGENT_ID, {
      task: prompt,
      sessionId: currentSessionId,
    });
    console.log('[App] Orchestrator result:', result);
  } catch (err) {
    console.error('[App] Failed to execute orchestrator:', err);
  }
}

/**
 * 启动交互模式
 */
async function startInteractiveMode(): Promise<void> {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('\n[App] Interactive mode. Type /help for commands.\n');

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input.startsWith('/')) {
      await handleCommand(input);
    } else {
      await executePrompt(input);
    }

    rl.prompt();
  }
}

/**
 * 处理 /command
 */
async function handleCommand(commandLine: string): Promise<void> {
  const parts = commandLine.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'help':
      printHelp();
      break;

    case 'exit':
    case 'quit':
      console.log('[App] Goodbye!');
      rl?.close();
      process.exit(0);
      break;

    case 'status':
      printStatus();
      break;

    case 'session':
      handleSessionCommand(args);
      break;

    case 'compress':
      if (currentSessionId && sessionManager) {
        const result = await sessionManager.compressContext(currentSessionId);
        console.log(`[App] Context compressed: ${result.slice(0, 100)}...`);
      }
      break;

    case 'clear':
      console.clear();
      break;

    default:
      console.log(`[App] Unknown command: ${cmd}. Type /help for available commands.`);
  }
}

/**
 * 处理 session 子命令
 */
function handleSessionCommand(args: string[]): void {
  if (!sessionManager) return;

  const subCmd = args[0];

  switch (subCmd) {
    case 'list': {
      const sessions = sessionManager.listSessions();
      console.log('\nSessions:');
      sessions.forEach((s, i) => {
        const current = s.id === currentSessionId ? ' (current)' : '';
        console.log(`  ${i + 1}. ${s.name}${current} - ${s.messages.length} messages`);
      });
      break;
    }
    case 'new': {
      const name = args[1] || 'New Session';
      const session = sessionManager.createSession(process.cwd(), name);
      currentSessionId = session.id;
      console.log(`[App] Created and switched to: ${session.name}`);
      break;
    }
    case 'switch': {
      const targetId = args[1];
      if (sessionManager.getSession(targetId)) {
        currentSessionId = targetId;
        sessionManager.setCurrentSession(targetId);
        console.log(`[App] Switched to session: ${targetId}`);
      } else {
        console.log(`[App] Session not found: ${targetId}`);
      }
      break;
    }
    default:
      console.log(`[App] Unknown session command: ${subCmd}`);
      console.log('  Available: list, new, switch');
  }
}

/**
 * 打印帮助
 */
function printHelp(): void {
  console.log(`
Commands:
  /help              Show this help
  /status            Show current status
  /session list      List all sessions
  /session new [name] Create new session
  /session switch <id> Switch to session
  /compress          Compress context
  /clear             Clear screen
  /exit              Exit interactive mode
`);
}

/**
 * 打印状态
 */
function printStatus(): void {
  if (!sessionManager || !currentSessionId) return;

  const session = sessionManager.getSession(currentSessionId);
  if (!session) return;

  const compression = sessionManager.getCompressionStatus(currentSessionId);

  console.log(`
Session: ${session.name}
  ID: ${session.id}
  Messages: ${session.messages.length}
  Compressed: ${compression.compressed ? `Yes (${compression.originalCount} messages)` : 'No'}
  Paused: ${sessionManager.isPaused(currentSessionId) ? 'Yes' : 'No'}
`);
}

/**
 * 打印事件
 */
function printEvent(event: RuntimeEvent): void {
  const timestamp = new Date(event.timestamp).toLocaleTimeString();

  switch (event.type) {
    case 'user_message':
      console.log(`[${timestamp}] You: ${(event as { payload: { content: string } }).payload.content}`);
      break;

    case 'assistant_chunk':
      process.stdout.write((event as { payload: { content: string } }).payload.content);
      break;

    case 'assistant_complete':
      console.log(); // newline after streaming
      break;

    case 'task_started':
      console.log(`[${timestamp}] Task started: ${(event as { payload: { title: string } }).payload.title}`);
      break;

    case 'task_completed':
      console.log(`[${timestamp}] Task completed`);
      break;

    case 'task_failed':
      console.log(`[${timestamp}] Task failed: ${(event as { payload: { error: string } }).payload.error}`);
      break;

    case 'workflow_progress': {
      const p = (event as { payload: { overallProgress: number; completedTasks: number; pendingTasks: number } }).payload;
      console.log(`[${timestamp}] Progress: ${p.overallProgress}% (${p.completedTasks}/${p.completedTasks + p.pendingTasks})`);
      break;
    }
  }
}

// 如果直接运行此文件
if (import.meta.url === `file://${process.argv[1]}`) {
  runAppCLI(process.argv.slice(2)).catch(console.error);
}
