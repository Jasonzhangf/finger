/**
 * OpenClaw Gateway Bridge Service
 * 
 * CLI 命令管理一个独立的服务进程，支持 WebSocket 和 stdio 双模式通信
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
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('OpenclawGatewayBridge');

const log = logger.module('GatewayBridge');

// 默认端口
const DEFAULT_WS_PORT = 19999;
const DEFAULT_PLUGIN_DIR = resolveDefaultPluginDir();
const PID_FILE_DIR = path.join(os.homedir(), '.finger', 'run');
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.finger', 'runtime', 'plugins', 'openclaw-qqbot.json');
const CHANNELS_CONFIG_PATH = path.join(os.homedir(), '.finger', 'config', 'channels.json');

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

  // 连接 QQBot（启动 account）
  bridge
    .command('connect <channel-id>')
    .description('Connect gateway account (start account)')
    .option('-w, --ws-port <port>', 'WebSocket port', parseInt, DEFAULT_WS_PORT)
    .option('--app-id <id>', 'QQBot AppID (optional, reads from config if omitted)')
    .option('--secret <secret>', 'QQBot AppSecret (optional, reads from config if omitted)')
    .option('--timeout <ms>', 'Timeout for ready event', parseInt, 30000)
    .action(async (channelId: string, options: { wsPort: number; appId?: string; secret?: string; timeout: number }) => {
      const wsPort = Number.isFinite(options.wsPort) ? options.wsPort : DEFAULT_WS_PORT;
      const config = loadQqbotConfig();
      const appId = options.appId || config?.appId;
      const clientSecret = options.secret || config?.clientSecret;

      if (!appId || !clientSecret) {
        clog.error('Missing appId or clientSecret. Provide via --app-id/--secret or config file.');
        process.exit(1);
      }

      await sendStartAction(channelId, wsPort, appId, clientSecret, options.timeout);
    });

  // 断开连接（停止 account）
  bridge
    .command('disconnect <channel-id>')
    .description('Disconnect gateway account (stop account)')
    .option('-w, --ws-port <port>', 'WebSocket port', parseInt, DEFAULT_WS_PORT)
    .action(async (_channelId: string, options: { wsPort: number }) => {
      const wsPort = Number.isFinite(options.wsPort) ? options.wsPort : DEFAULT_WS_PORT;
      await sendStopAction(wsPort);
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
    .action(async (_channelId: string, options: { to: string; text: string; wsPort: number }) => {
      const wsPort = Number.isFinite(options.wsPort) ? options.wsPort : DEFAULT_WS_PORT;
      await sendMessage(options.to, options.text, wsPort);
    });
}

/**
 * Resolve default plugin directory
 */
function resolveDefaultPluginDir(): string {
  const runtimeDir = path.join(os.homedir(), '.finger', 'runtime', 'plugins');
  const legacyDir = path.join(os.homedir(), '.finger', 'plugins');
  if (fs.existsSync(runtimeDir)) {
    return runtimeDir;
  }
  return legacyDir;
}

/**
 * Load QQBot config from ~/.finger/runtime/plugins/openclaw-qqbot.json
 */
function loadQqbotConfig(): { appId?: string; clientSecret?: string } | null {
  if (!fs.existsSync(DEFAULT_CONFIG_PATH)) return null;

  try {
    const raw = fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { config?: { appId?: string; clientSecret?: string } };
    return parsed.config ?? null;
  } catch {
    return null;
  }
}

function loadChannelsConfig(): { channels?: Array<{ id?: string; channelId?: string; credentials?: { appid?: string; token?: string } }> } | null {
  if (!fs.existsSync(CHANNELS_CONFIG_PATH)) return null;

  try {
    const raw = fs.readFileSync(CHANNELS_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as { channels?: Array<{ id?: string; channelId?: string; credentials?: { appid?: string; token?: string } }> };
  } catch {
    return null;
  }
}

function resolveSendConfig(channelId: string, payloadCfg?: unknown): { channels: Record<string, { appId: string; clientSecret: string; enabled: boolean }> } | null {
  if (payloadCfg && typeof payloadCfg === 'object') {
    return payloadCfg as { channels: Record<string, { appId: string; clientSecret: string; enabled: boolean }> };
  }

  const qqbotConfig = loadQqbotConfig();
  if (qqbotConfig?.appId && qqbotConfig.clientSecret) {
    return {
      channels: {
        [channelId]: {
          appId: qqbotConfig.appId,
          clientSecret: qqbotConfig.clientSecret,
          enabled: true,
        },
      },
    };
  }

  const channelsConfig = loadChannelsConfig();
  const channel = channelsConfig?.channels?.find((entry) => entry.id === channelId || entry.channelId === channelId);
  const appId = channel?.credentials?.appid;
  const clientSecret = channel?.credentials?.token;
  if (!appId || !clientSecret) return null;

  return {
    channels: {
      [channelId]: {
        appId,
        clientSecret,
        enabled: true,
      },
    },
  };
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
      clog.log(`Gateway bridge for ${channelId} is already running (PID: ${pid})`);
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
  
  clog.log(`Gateway bridge for ${channelId} started (PID: ${child.pid})`);
  if (options.wsPort) {
    clog.log(`WebSocket server listening on port ${options.wsPort}`);
  }
}

/**
 * 停止服务
 */
async function stopService(channelId: string): Promise<void> {
  const pidFile = getPidFilePath(channelId);
  
  if (!fs.existsSync(pidFile)) {
    clog.log(`Gateway bridge for ${channelId} is not running`);
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
  
  try {
    process.kill(pid, 'SIGTERM');
    clog.log(`Gateway bridge for ${channelId} stopped (PID: ${pid})`);
  } catch (error) {
    clog.log(`Failed to stop gateway bridge: ${error}`);
  }
  
  fs.unlinkSync(pidFile);
}

/**
 * 查看状态
 */
async function checkStatus(channelId: string): Promise<void> {
  const pidFile = getPidFilePath(channelId);
  
  if (!fs.existsSync(pidFile)) {
    clog.log(`Gateway bridge for ${channelId} is not running`);
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
  
  try {
    process.kill(pid, 0);
    clog.log(`Gateway bridge for ${channelId} is running (PID: ${pid})`);
  } catch {
    clog.log(`Gateway bridge for ${channelId} is not running (stale PID file)`);
    fs.unlinkSync(pidFile);
  }
}

/**
 * 发送消息
 */
async function sendMessage(to: string, text: string, wsPort: number): Promise<void> {
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
    try {
      const msg = JSON.parse(data.toString());

      // Handle events
      if (msg.event) {
        return; // Ignore events in send command
      }

      // Handle responses
      const response = msg as GatewayResponse;
      if (response.ok) {
        clog.log('Message sent successfully');
      } else {
        clog.error(`Failed to send message: ${response.error}`);
      }
      ws.close();
      process.exit(response.ok ? 0 : 1);
    } catch (error) {
      clog.error(`Failed to parse message: ${error}`);
      ws.close();
      process.exit(1);
    }
  });

  ws.on('error', (error) => {
    clog.error(`WebSocket error: ${error.message}`);
    process.exit(1);
  });
}

/**
 * 发送 start action 并等待 ready 事件
 */
async function sendStartAction(channelId: string, wsPort: number, appId: string, clientSecret: string, timeoutMs: number): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${wsPort}`);

  const timeout = setTimeout(() => {
    clog.error('Timeout waiting for ready event');
    ws.close();
    process.exit(1);
  }, timeoutMs);

  ws.on('open', () => {
    const message: GatewayMessage = {
      action: 'start',
      payload: { appId, clientSecret },
      requestId: `req-${Date.now()}`,
    };
    ws.send(JSON.stringify(message));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === 'ready') {
        clearTimeout(timeout);
        clog.log(`Gateway ${channelId} ready`);
        ws.close();
        process.exit(0);
      }
      if (msg.event === 'error') {
        clearTimeout(timeout);
        clog.error(`Gateway error: ${JSON.stringify(msg.data)}`);
        ws.close();
        process.exit(1);
      }
      if (msg.ok === false) {
        clearTimeout(timeout);
        clog.error(`Start failed: ${msg.error}`);
        ws.close();
        process.exit(1);
      }
    } catch {
      // ignore non-json
    }
  });

  ws.on('error', (error) => {
    clearTimeout(timeout);
    clog.error(`WebSocket error: ${error.message}`);
    process.exit(1);
  });
}

/**
 * 发送 stop action
 */
async function sendStopAction(wsPort: number): Promise<void> {
  const ws = new WebSocket(`ws://localhost:${wsPort}`);

  ws.on('open', () => {
    const message: GatewayMessage = {
      action: 'stop',
      requestId: `req-${Date.now()}`,
    };
    ws.send(JSON.stringify(message));
  });

  ws.on('message', (data) => {
    const response = JSON.parse(data.toString()) as GatewayResponse;
    if (response.ok) {
      clog.log('Gateway stopped');
    } else {
      clog.error(`Failed to stop gateway: ${response.error}`);
    }
    ws.close();
    process.exit(response.ok ? 0 : 1);
  });

  ws.on('error', (error) => {
    clog.error(`WebSocket error: ${error.message}`);
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
    clog.error(`Failed to initialize: ${errorMessage}`);
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
    clog.log(`Gateway bridge for ${channelId} started on ws://localhost:${wsPort}`);
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
      pluginConfigs: loadPluginConfigs(),
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

    const cfg = resolveSendConfig(this.channelId, payload.cfg);
    if (!cfg?.channels?.[this.channelId]) {
      return { ok: false, error: 'Missing channel config (cfg.channels) for send' };
    }

    try {
      const result = await this.handler.sendText({
        to,
        text,
        accountId,
        replyToId,
        cfg,
      });

      if (result.error) {
        const errorMessage = typeof result.error === 'string'
          ? result.error
          : JSON.stringify(result.error);
        return { ok: false, error: errorMessage };
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

    if (!appId || !clientSecret) {
      return { ok: false, error: 'Missing appId or clientSecret' };
    }

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
         this.emitEvent('ready', { channelId: this.channelId });
      },
      onError: (err: Error) => {
        this.emitEvent('error', { message: err.message });
      },
      getStatus: () => ({
        running: this.running,
        connected: true,
        lastConnectedAt: Date.now(),
      }),
      setStatus: (status: Record<string, unknown>) => {
        log.info('Status update:', status);
        const running = (status as { running?: boolean }).running === true;
        const connected = (status as { connected?: boolean }).connected === true;
        if (running && connected) {
          this.running = true;
          log.info('Gateway ready (via setStatus)');
          this.emitEvent('ready', { channelId: this.channelId });
        }
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

/**
 * Load plugin configs from ~/.finger/runtime/plugins/*.json
 */
function loadPluginConfigs(): Record<string, Record<string, unknown>> {
  const configs: Record<string, Record<string, unknown>> = {};
  const runtimePluginDir = path.join(os.homedir(), '.finger', 'runtime', 'plugins');

  if (!fs.existsSync(runtimePluginDir)) {
    return configs;
  }

  const entries = fs.readdirSync(runtimePluginDir).filter((f) => f.endsWith('.json'));
  for (const entry of entries) {
    try {
      const content = fs.readFileSync(path.join(runtimePluginDir, entry), 'utf-8');
      const parsed = JSON.parse(content) as { id?: string; config?: Record<string, unknown> };
      if (parsed.id && parsed.config) {
        configs[parsed.id] = parsed.config;
      }
    } catch {
      // ignore invalid config
    }
  }

  return configs;
}
