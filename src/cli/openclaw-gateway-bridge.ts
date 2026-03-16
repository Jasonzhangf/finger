/**
 * OpenClaw Gateway Bridge Service
 * 
 * CLI 命令管理一个独立的服务进程，支持 WebSocket 和 stdio 双模式通信
 * 
 * ## 架构
 * ```
 * CLI (finger gateway-bridge) ←spawn→ Service Process
 *                                        ↓
 *                              WebSocket Server (port 19999) 或 stdio
 *                                        ↓
 *                              OpenClaw Gateway (qqbot, etc.)
 * ```
 * 
 * ## 使用方式
 *   # 启动服务（WebSocket 模式）
 *   finger gateway-bridge start qqbot --ws-port 19999
 *   
 *   # 启动服务（stdio 模式）
 *   finger gateway-bridge start qqbot --stdio
 *   
 *   # 停止服务
 *   finger gateway-bridge stop qqbot
 *   
 *   # 查看状态
 *   finger gateway-bridge status qqbot
 *   
 *   # 发送消息
 *   finger gateway-bridge send qqbot --to "user-123" --text "Hello"
 * 
 * ## WebSocket 协议
 *   // 客户端发送
 *   {"action": "send", "payload": {"to": "user-123", "text": "Hello"}}
 *   {"action": "start", "payload": {"appId": "xxx", "clientSecret": "xxx"}}
 *   {"action": "stop"}
 *   {"action": "ping"}
 *   
 *   // 服务端响应
 *   {"ok": true, "requestId": "req-1", "result": {...}}
 *   {"ok": false, "requestId": "req-1", "error": "..."}
 *   
 *   // 服务端推送事件
 *   {"event": "message", "data": {...}}
 *   {"event": "ready", "data": {"channelId": "qqbot"}}
 *   {"event": "error", "data": {"message": "..."}}
 */

import { Command } from 'commander';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { OpenClawGateBlock } from '../blocks/openclaw-gate/index.js';
import { createPluginManager, type PluginManagerOptions } from '../blocks/openclaw-plugin-manager/index.js';
import { getChannelHandler, type ChannelPluginHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { logger } from '../core/logger.js';

const log = logger.module('GatewayBridge');

// 默认端口
const DEFAULT_WS_PORT = 19999;
const DEFAULT_PLUGIN_DIR = path.join(os.homedir(), '.finger', 'plugins');
const PID_FILE_DIR = path.join(os.homedir(), '.finger', 'run');

// 消息类型
export interface GatewayMessage {
  action: 'send' | 'start' | 'stop' | 'ping';
  payload?: Record<string, unknown>;
  requestId?: string;
}

export interface GatewayResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  requestId?: string;
}

export interface GatewayEvent {
  event: 'message' | 'error' | 'ready' | 'stopped';
  data: unknown;
}

/**
 * 注册 CLI 命令
 */
export function registerOpenClawGatewayBridgeCommand(program: Command): void {
  const bridge = program.command('gateway-bridge').description('Manage OpenClaw gateway bridge service');

  // 启动服务
  bridge
    .command('start <channel-id>')
    .description('Start gateway bridge service')
    .option('-p, --plugin-dir <path>', 'Plugin directory path', DEFAULT_PLUGIN_DIR)
    .option('-w, --ws-port <port>', 'WebSocket port (default: 19999)', parseInt)
    .option('--stdio', 'Use stdio mode instead of WebSocket', false)
    .option('-d, --debug', 'Enable debug logging', false)
    .option('--daemon', 'Run as daemon (background)', false)
    .action(async (channelId: string, options: { pluginDir: string; wsPort?: number; stdio: boolean; debug: boolean; daemon: boolean }) => {
      const wsPort = options.wsPort ?? DEFAULT_WS_PORT;
      
      if (options.daemon) {
        // Daemon 模式：fork 自己作为后台进程
        await startDaemon(channelId, options);
      } else if (options.stdio) {
        // stdio 模式
        await runStdioMode(channelId, options);
      } else {
        // WebSocket 模式
        await runWebSocketMode(channelId, wsPort, options);
      }
    });

  // 停止服务
  bridge
    .command('stop <channel-id>')
    .description('Stop gateway bridge service')
    .action(async (channelId: string) => {
      await stopService(channelId);
    });

  // 查看状态
  bridge
    .command('status <channel-id>')
    .description('Check gateway bridge service status')
    .action(async (channelId: string) => {
      await checkStatus(channelId);
    });

  // 发送消息
  bridge
    .command('send <channel-id>')
    .description('Send message through gateway')
    .requiredOption('-t, --to <target>', 'Target user/group ID')
    .requiredOption('-m, --text <message>', 'Message text')
    .option('-w, --ws-port <port>', 'WebSocket port', parseInt, DEFAULT_WS_PORT)
    .action(async (channelId: string, options: { to: string; text: string; wsPort: number }) => {
      await sendMessage(channelId, options.to, options.text, options.wsPort);
    });
}

/**
 * 启动 Daemon 模式
 */
async function startDaemon(channelId: string, options: { pluginDir: string; wsPort?: number; stdio: boolean; debug: boolean }): Promise<void> {
  const pidFile = getPidFilePath(channelId);
  
  // 检查是否已运行
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
    try {
      process.kill(pid, 0);
      console.log(`Gateway bridge for ${channelId} is already running (PID: ${pid})`);
      return;
    } catch {
      // 进程不存在，删除 pid 文件
      fs.unlinkSync(pidFile);
    }
  }

  // 确保 run 目录存在
  if (!fs.existsSync(PID_FILE_DIR)) {
    fs.mkdirSync(PID_FILE_DIR, { recursive: true });
  }

  // Fork 自己作为后台进程
  const { spawn } = await import('child_process');
  const args = [
    'gateway-bridge', 'start', channelId,
    '--plugin-dir', options.pluginDir,
  ];
  if (options.wsPort) {
    args.push('--ws-port', String(options.wsPort));
  }
  if (options.debug) {
    args.push('--debug');
  }

  const child = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: 'ignore',
  });

  // 写入 PID 文件
  fs.writeFileSync(pidFile, String(child.pid));
  
  child.unref();
  
  console.log(`Gateway bridge for ${channelId} started (PID: ${child.pid})`);
  if (options.wsPort) {
    console.log(`WebSocket server listening on port ${options.wsPort}`);
  }
}

/**
 * 停止服务
 */
async function stopService(channelId: string): Promise<void> {
  const pidFile = getPidFilePath(channelId);
  
  if (!fs.existsSync(pidFile)) {
    console.log(`Gateway bridge for ${channelId} is not running`);
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
  
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Gateway bridge for ${channelId} stopped (PID: ${pid})`);
  } catch (error) {
    console.log(`Failed to stop gateway bridge: ${error}`);
  }
  
  fs.unlinkSync(pidFile);
}

/**
 * 查看状态
 */
async function checkStatus(channelId: string): Promise<void> {
  const pidFile = getPidFilePath(channelId);
  
  if (!fs.existsSync(pidFile)) {
    console.log(`Gateway bridge for ${channelId} is not running`);
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
  
  try {
    process.kill(pid, 0);
    console.log(`Gateway bridge for ${channelId} is running (PID: ${pid})`);
  } catch {
    console.log(`Gateway bridge for ${channelId} is not running (stale PID file)`);
    fs.unlinkSync(pidFile);
  }
}

/**
 * 发送消息
 */
async function sendMessage(channelId: string, to: string, text: string, wsPort: number): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${wsPort}`);
  
  ws.on('open', () => {
    const message: GatewayMessage = {
      action: 'send',
      payload: { to, text },
      requestId: `req-${Date.now()}`,
    };
    ws.send(JSON.stringify(message));
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data.toString()) as GatewayResponse;
    if (response.ok) {
      console.log('Message sent successfully');
    } else {
      console.error(`Failed to send message: ${response.error}`);
    }
    ws.close();
    process.exit(response.ok ? 0 : 1);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error: ${error.message}`);
    process.exit(1);
  });
}

/**
 * 运行 WebSocket 模式
 */
async function runWebSocketMode(channelId: string, wsPort: number, options: { pluginDir: string; debug: boolean }): Promise<void> {
  const service = new GatewayBridgeService(channelId, options.pluginDir);
  
  try {
    await service.initialize();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Failed to initialize: ${errorMessage}`);
    process.exit(1);
  }

  // 创建 HTTP server
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WebSocket) => {
    log.info('Client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as GatewayMessage;
        const response = await service.handleMessage(message);
        ws.send(JSON.stringify(response));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        ws.send(JSON.stringify({ ok: false, error: errorMessage }));
      }
    });

    ws.on('close', () => {
      log.info('Client disconnected');
    });
  });

  // 订阅服务事件，推送给所有客户端
  service.onEvent((event: GatewayEvent) => {
    const data = JSON.stringify(event);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  });

  server.listen(wsPort, () => {
    log.info(`WebSocket server listening on port ${wsPort}`);
    console.log(`Gateway bridge for ${channelId} started on ws://localhost:${wsPort}`);
  });

  // 写入 PID 文件（如果不是 daemon 模式）
  const pidFile = getPidFilePath(channelId);
  if (!fs.existsSync(PID_FILE_DIR)) {
    fs.mkdirSync(PID_FILE_DIR, { recursive: true });
  }
  fs.writeFileSync(pidFile, String(process.pid));

  // 处理退出信号
  process.on('SIGTERM', () => {
    log.info('Received SIGTERM, shutting down...');
    service.stop();
    server.close(() => {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    log.info('Received SIGINT, shutting down...');
    service.stop();
    server.close(() => {
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
      process.exit(0);
    });
  });
}

/**
 * 运行 stdio 模式
 */
async function runStdioMode(channelId: string, options: { pluginDir: string; debug: boolean }): Promise<void> {
  const service = new GatewayBridgeService(channelId, options.pluginDir);
  
  try {
    await service.initialize();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: `Failed to initialize: ${errorMessage}` }) + '\n');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  log.info('Gateway bridge ready (stdio mode)');

  rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as GatewayMessage;
      const response = await service.handleMessage(message);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stdout.write(JSON.stringify({ ok: false, error: errorMessage }) + '\n');
    }
  });

  // 订阅服务事件，推送到 stdout
  service.onEvent((event: GatewayEvent) => {
    process.stdout.write(JSON.stringify(event) + '\n');
  });

  rl.on('close', () => {
    log.info('Stdin closed, exiting...');
    service.stop();
    process.exit(0);
  });
}

/**
 * 获取 PID 文件路径
 */
function getPidFilePath(channelId: string): string {
  return path.join(PID_FILE_DIR, `gateway-bridge-${channelId}.pid`);
}

/**
 * Gateway Bridge 服务核心类
 */
class GatewayBridgeService {
  private channelId: string;
  private pluginDir: string;
  private gate: OpenClawGateBlock | null = null;
  private handler: ChannelPluginHandler | null = null;
  private initialized = false;
  private abortController: AbortController | null = null;
  private running = false;
  private eventListeners: Array<(event: GatewayEvent) => void> = [];

  constructor(channelId: string, pluginDir: string) {
    this.channelId = channelId;
    this.pluginDir = pluginDir;
  }

  async initialize(): Promise<void> {
    // 创建 gate block
    this.gate = new OpenClawGateBlock(`gateway-${this.channelId}`, { pluginDir: this.pluginDir });

    // 加载插件
    const managerOptions: PluginManagerOptions = {
      pluginDir: this.pluginDir,
      gate: this.gate,
    };
    const pluginManager = createPluginManager(managerOptions);
    await pluginManager.loadAll();
    
    // 启用所有插件
    for (const plugin of pluginManager.getAllPlugins()) {
      if (!plugin.enabled) {
        pluginManager.enable(plugin.id);
      }
    }

    // 获取 channel handler
    this.handler = getChannelHandler(this.channelId) || null;
    
    if (!this.handler) {
      throw new Error(`No handler registered for channel: ${this.channelId}`);
    }

    log.info(`Handler loaded - sendText: ${!!this.handler.sendText}, startAccount: ${!!this.handler.startAccount}`);
    this.initialized = true;
  }

  async handleMessage(message: GatewayMessage): Promise<GatewayResponse> {
    if (!this.initialized) {
      return { ok: false, error: 'Service not initialized', requestId: message.requestId };
    }

    const { action, payload = {} } = message;

    switch (action) {
      case 'ping':
        return { ok: true, result: { pong: true, channelId: this.channelId, running: this.running }, requestId: message.requestId };

      case 'send':
        return { ...(await this.handleSend(payload)), requestId: message.requestId };

      case 'start':
        return { ...(await this.handleStart(payload)), requestId: message.requestId };

      case 'stop':
        return { ...(await this.handleStop()), requestId: message.requestId };

      default:
        return { ok: false, error: `Unknown action: ${(message as any).action}`, requestId: message.requestId };
    }
  }

  private async handleSend(payload: Record<string, unknown>): Promise<GatewayResponse> {
    if (!this.handler?.sendText) {
      return { ok: false, error: 'sendText not available for this channel' };
    }

    const to = String(payload.to ?? '');
    const text = String(payload.text ?? '');
    const accountId = payload.accountId ? String(payload.accountId) : undefined;
    const replyToId = payload.replyToId ? String(payload.replyToId) : undefined;

    if (!to || !text) {
      return { ok: false, error: 'Missing required fields: to, text' };
    }

    try {
      const result = await this.handler.sendText({
        to,
        text,
        accountId,
        replyToId,
        cfg: payload.cfg,
      });

      if (result.error) {
        return { ok: false, error: result.error };
      }

      return { ok: true, result };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    }
  }

  private async handleStart(payload: Record<string, unknown>): Promise<GatewayResponse> {
    if (!this.handler?.startAccount) {
      return { ok: false, error: 'startAccount not available for this channel' };
    }

    if (this.running) {
      return { ok: false, error: 'Gateway already running' };
    }

    const { appId, clientSecret, ...rest } = payload;

    try {
      this.abortController = new AbortController();

      // 创建 context 用于 gateway 启动
      const ctx = {
        callbacks: {
          onMessage: (msg: unknown) => {
            this.emitEvent('message', msg);
          },
          onError: (err: Error) => {
            this.emitEvent('error', { message: err.message });
          },
          onReady: () => {
            this.emitEvent('ready', { channelId: this.channelId });
          },
        },
        account: {
          accountId: 'default',
          appId,
          clientSecret,
          ...rest,
        },
        cfg: {},
        log,
        onReady: () => {
          this.running = true;
          log.info('Gateway ready');
        },
        onError: (err: Error) => {
          this.emitEvent('error', { message: err.message });
        },
        abortSignal: this.abortController.signal,
      };

      // 异步启动 gateway
      this.handler.startAccount(ctx).then(() => {
        this.running = false;
        this.emitEvent('stopped', { channelId: this.channelId });
      }).catch((err) => {
        this.running = false;
        this.emitEvent('error', { message: err.message });
      });

      return { ok: true, result: { starting: true, channelId: this.channelId } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    }
  }

  private async handleStop(): Promise<GatewayResponse> {
    if (!this.running) {
      return { ok: false, error: 'Gateway not running' };
    }

    this.stop();
    return { ok: true, result: { stopped: true } };
  }

  onEvent(listener: (event: GatewayEvent) => void): void {
    this.eventListeners.push(listener);
  }

  private emitEvent(event: GatewayEvent['event'], data: unknown): void {
    const eventData: GatewayEvent = { event, data };
    for (const listener of this.eventListeners) {
      listener(eventData);
    }
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.running = false;
    this.initialized = false;
    log.info('Gateway bridge stopped');
  }
}
