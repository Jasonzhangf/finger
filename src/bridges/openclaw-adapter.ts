/**
 * OpenClaw Bridge Adapter - 适配 OpenClaw 插件到标准 Channel Bridge
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions } from './types.js';
import type { ChannelPluginHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { getChannelHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { logger } from '../core/logger.js';

const log = logger.module('OpenClawBridgeAdapter');

type GatewayContext = {
  callbacks?: ChannelBridgeCallbacks;
  account: {
    accountId: string;
    appId?: string;
    clientSecret?: string;
    [key: string]: unknown;
  };
  cfg: Record<string, unknown>;
  log: typeof log;
  onReady: () => void;
  onError: (err: Error) => void;
  setStatus?: (status: Record<string, unknown>) => void;
  getStatus?: () => Record<string, unknown>;
  abortSignal: AbortSignal;
};

export class OpenClawBridgeAdapter implements ChannelBridge {
  readonly id: string;
  readonly channelId: string;
  private config: ChannelBridgeConfig;
  private callbacks: ChannelBridgeCallbacks;
  private handler: ChannelPluginHandler | null = null;
  private running = false;
  private abortController: AbortController | null = null;

  // Expose callbacks for runtime access
  get callbacks_(): ChannelBridgeCallbacks {
    return this.callbacks;
  }

  constructor(config: ChannelBridgeConfig, callbacks: ChannelBridgeCallbacks) {
    this.id = config.id;
    this.channelId = config.channelId;
    this.config = config;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    // 获取 OpenClaw 插件注册的 handler
    this.handler = getChannelHandler(this.channelId) || null;

    if (!this.handler) {
      throw new Error(`No handler registered for channel: ${this.channelId}`);
    }

    log.info(`[${this.id}] Found handler - sendText: ${!!this.handler.sendText}, startAccount: ${!!this.handler.startAccount}`);

    // 如果有 startAccount，调用它启动 gateway
    if (this.handler.startAccount) {
      log.info(`[${this.id}] Starting gateway via startAccount...`);

      // Create AbortController for gateway lifecycle
      this.abortController = new AbortController();

      try {
        // Build config for OpenClaw plugin
        const pluginCfg = {
          channels: {
            [this.channelId]: {
              appId: this.config.credentials.appid as string,
              clientSecret: this.config.credentials.token as string,
              enabled: true,
            },
          },
        };

        const ctx: GatewayContext = {
          callbacks: this.callbacks,
          account: {
            accountId: this.config.credentials.accountId as string || 'default',
            appId: this.config.credentials.appid as string,
            clientSecret: this.config.credentials.token as string,
            ...this.config.credentials,
          },
          cfg: pluginCfg,
          log,
          onReady: () => {
            log.info(`[${this.id}] Gateway ready callback`);
            this.running = true;
            this.callbacks.onReady();
          },
          onError: (err: Error) => {
            log.error(`[${this.id}] Gateway error: ${err.message}`);
            this.callbacks.onError(err);
          },
          setStatus: (status) => log.info(`[${this.id}] Status update:`, status),
          getStatus: () => ({}),
          abortSignal: this.abortController.signal,
        };

        const startPromise = this.handler.startAccount(ctx);
        Promise.resolve(startPromise).catch((err) => {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error(`[${this.id}] startAccount error: ${error.message}`);
          this.callbacks.onError(error);
        });
        log.info(`[${this.id}] startAccount launched`);
      } catch (err) {
        log.error(`[${this.id}] startAccount error:`, err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    } else {
      this.running = true;
      this.callbacks.onReady();
      log.info(`[${this.id}] Started (no startAccount, immediate ready)`);
    }
  }

  async stop(): Promise<void> {
    // Abort the gateway if running
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.running = false;
    log.info(`[${this.id}] Stopped`);
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(options: SendMessageOptions): Promise<{ messageId: string }> {
    if (!this.handler?.sendText) {
      throw new Error(`Handler does not support sendText for channel: ${this.channelId}`);
    }

    const appId = this.config.credentials.appid as string | undefined;
    const clientSecret = this.config.credentials.token as string | undefined;
    if (!appId || !clientSecret) {
      throw new Error('QQBot not configured (missing appId or clientSecret)');
    }

    const cfg = {
      channels: {
        [this.channelId]: {
          appId,
          clientSecret,
          enabled: true,
        },
      },
    };

    log.info(`[${this.id}] sendMessage - cfg keys: channels=${!!cfg.channels}, qqbot=${!!cfg.channels?.[this.channelId]}`);

    const result = await this.handler.sendText({
      to: options.to,
      text: options.text,
      replyToId: options.replyTo,
      accountId: this.config.credentials.accountId as string | undefined,
      cfg,
    });

    if (result.error) {
      throw new Error(result.error);
    }

    return { messageId: result.messageId || '' };
  }
}
