/**
 * OpenClaw Gateway Bridge CLI
 * 
 * 通过 stdin/stdout 提供 gateway 功能的 CLI 命令
 * 支持作为子进程被其他系统调用
 * 
 * 使用方式:
 *   finger gateway-bridge <channel-id> [--plugin-dir <path>]
 * 
 * 消息格式 (stdin):
 *   {"action": "send", "payload": {"to": "user-123", "text": "Hello"}}
 *   {"action": "receive", "payload": {"from": "user-123", "text": "Hi"}}
 *   {"action": "start", "payload": {"appId": "xxx", "clientSecret": "xxx"}}
 *   {"action": "stop"}
 * 
 * 响应格式 (stdout):
 *   {"ok": true, "result": {...}}
 *   {"ok": false, "error": "..."}
 */

import { Command } from 'commander';
import * as readline from 'readline';
import * as path from 'path';
import * as os from 'os';
import { OpenClawGateBlock } from '../blocks/openclaw-gate/index.js';
import { createPluginManager } from '../blocks/openclaw-plugin-manager/index.js';
import { getChannelHandler, type ChannelPluginHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { logger } from '../core/logger.js';

const log = logger.module('GatewayBridge');

export interface GatewayBridgeMessage {
  action: 'send' | 'receive' | 'start' | 'stop' | 'ping';
  payload?: Record<string, unknown>;
  requestId?: string;
}

export interface GatewayBridgeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  requestId?: string;
}

export function registerOpenClawGatewayBridgeCommand(program: Command): void {
  program
    .command('gateway-bridge <channel-id>')
    .description('Start OpenClaw gateway bridge with stdin/stdout communication')
    .option('-p, --plugin-dir <path>', 'Plugin directory path', '~/.finger/plugins')
    .option('-d, --debug', 'Enable debug logging', false)
    .action(async (channelId: string, options: { pluginDir: string; debug: boolean }) => {
      const pluginDir = options.pluginDir.startsWith('~/')
        ? path.join(os.homedir(), options.pluginDir.slice(2))
        : options.pluginDir;

      if (options.debug) {
        process.env.DEBUG = 'true';
      }

      log.info(`Starting gateway bridge for channel: ${channelId}`);
      log.info(`Plugin directory: ${pluginDir}`);

      // 初始化 gateway
      const bridge = new OpenClawGatewayBridge(channelId, pluginDir);
      
      try {
        await bridge.initialize();
        bridge.startRepl();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        bridge.respond({ ok: false, error: `Failed to initialize: ${errorMessage}` });
        process.exit(1);
      }
    });
}

class OpenClawGatewayBridge {
  private channelId: string;
  private pluginDir: string;
  private gate: OpenClawGateBlock | null = null;
  private handler: ChannelPluginHandler | null = null;
  private initialized = false;
  private rl: readline.Interface | null = null;

  constructor(channelId: string, pluginDir: string) {
    this.channelId = channelId;
    this.pluginDir = pluginDir;
  }

  async initialize(): Promise<void> {
    // 创建 gate block
    this.gate = new OpenClawGateBlock(`gateway-${this.channelId}`, { pluginDir: this.pluginDir });

    // 加载插件
    const pluginManager = createPluginManager(this.pluginDir);
    await pluginManager.discover();
    
    // 加载已安装的插件到 gate
    for (const plugin of pluginManager.list()) {
      await this.gate.installPlugin(plugin.id, plugin.path);
      if (plugin.status !== 'enabled') {
        await this.gate.enablePlugin(plugin.id);
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

  startRepl(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    log.info('Gateway bridge ready, listening on stdin...');

    this.rl.on('line', (line: string) => {
      this.handleLine(line).catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.respond({ ok: false, error: errorMessage });
      });
    });

    this.rl.on('close', () => {
      log.info('Stdin closed, exiting...');
      this.stop();
      process.exit(0);
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;

    let message: GatewayBridgeMessage;
    try {
      message = JSON.parse(line) as GatewayBridgeMessage;
    } catch {
      this.respond({ ok: false, error: 'Invalid JSON input' });
      return;
    }

    log.debug(`Received message: ${JSON.stringify(message)}`);

    if (!this.initialized) {
      this.respond({ ok: false, error: 'Bridge not initialized', requestId: message.requestId });
      return;
    }

    const response = await this.handleMessage(message);
    this.respond({ ...response, requestId: message.requestId });
  }

  private async handleMessage(message: GatewayBridgeMessage): Promise<GatewayBridgeResponse> {
    const { action, payload = {} } = message;

    switch (action) {
      case 'ping':
        return { ok: true, result: { pong: true, channelId: this.channelId } };

      case 'send':
        return await this.handleSend(payload);

      case 'receive':
        return await this.handleReceive(payload);

      case 'start':
        return await this.handleStart(payload);

      case 'stop':
        return await this.handleStop();

      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
  }

  private async handleSend(payload: Record<string, unknown>): Promise<GatewayBridgeResponse> {
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

  private async handleReceive(payload: Record<string, unknown>): Promise<GatewayBridgeResponse> {
    // receive 动作：模拟收到消息，返回格式化的消息对象
    // 这允许外部系统测试消息格式
    const from = String(payload.from ?? '');
    const text = String(payload.text ?? '');
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const message = {
      id: messageId,
      channelId: this.channelId,
      type: payload.type || 'direct',
      senderId: from,
      content: text,
      timestamp: Date.now(),
      metadata: payload,
    };

    return { ok: true, result: message };
  }

  private async handleStart(payload: Record<string, unknown>): Promise<GatewayBridgeResponse> {
    if (!this.handler?.startAccount) {
      return { ok: false, error: 'startAccount not available for this channel' };
    }

    const { appId, clientSecret, ...rest } = payload;

    try {
      // 创建 context 用于 gateway 启动
      const ctx = {
        callbacks: {
          onMessage: (msg: unknown) => {
            // 当收到消息时，输出到 stdout
            this.respond({ ok: true, result: { event: 'message', data: msg } });
          },
          onError: (err: Error) => {
            this.respond({ ok: false, error: err.message });
          },
          onReady: () => {
            log.info('Gateway ready');
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
        onReady: () => {},
        onError: () => {},
        abortSignal: new AbortController().signal,
      };

      await this.handler.startAccount(ctx);
      return { ok: true, result: { started: true, channelId: this.channelId } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { ok: false, error: errorMessage };
    }
  }

  private async handleStop(): Promise<GatewayBridgeResponse> {
    this.stop();
    return { ok: true, result: { stopped: true } };
  }

  private respond(response: GatewayBridgeResponse): void {
    const output = JSON.stringify(response);
    process.stdout.write(output + '\n');
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.initialized = false;
    log.info('Gateway bridge stopped');
  }
}
