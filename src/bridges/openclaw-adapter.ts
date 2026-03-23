/**
 * OpenClaw Bridge Adapter - Adapts OpenClaw plugins to standard Channel Bridge interface.
 *
 * Credential handling by channel type:
 * - type=openclaw-plugin: Uses config.credentials (channel-specific) + config.options.adapterConfig
 *   The OpenClaw plugin handler reads its own auth from ~/.openclaw state.
 *   Finger only provides the plugin config envelope.
 * - type=webui: No bridge adapter needed (handled by WebUI server directly).
 * - type=builtin: Legacy / built-in channels.
 *
 * Key change: credentials structure is channel-specific and not hardcoded here.
 * Each channel's config in channels.json defines its own credentials shape.
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions } from './types.js';
import type { ChannelPluginHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { getChannelHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { logger } from '../core/logger.js';

const log = logger.module('OpenClawBridgeAdapter');

type GatewayContext = {
  callbacks?: ChannelBridgeCallbacks;
  account: Record<string, unknown>;
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
    this.handler = getChannelHandler(this.channelId) || null;

    if (!this.handler) {
      throw new Error(`No handler registered for channel: ${this.channelId}`);
    }

    log.info(`[${this.id}] Found handler - sendText: ${!!this.handler.sendText}, startAccount: ${!!this.handler.startAccount}`);

    if (this.handler.startAccount) {
      log.info(`[${this.id}] Starting gateway via startAccount...`);
      this.abortController = new AbortController();

      try {
        // Build plugin config from credentials + adapterConfig
        const pluginCfg = {
          channels: {
            [this.channelId]: {
              ...this.config.credentials,
              ...(this.config.options?.adapterConfig || {}),
            },
          },
        };

        const ctx: GatewayContext = {
          callbacks: this.callbacks,
          account: {
            ...this.config.credentials,
            ...(this.config.options?.adapterConfig || {}),
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

    // Build cfg from credentials + adapterConfig for plugin handler
    const pluginCfg = {
      channels: {
        [this.channelId]: {
          ...this.config.credentials,
          ...(this.config.options?.adapterConfig || {}),
        },
      },
    };

    log.debug(`[${this.id}] sendMessage to=${options.to} cfg keys=${Object.keys(pluginCfg.channels[this.channelId] || {}).join(',')}`);

    const result = await this.handler.sendText({
      to: options.to,
      text: options.text,
      replyToId: options.replyTo,
      accountId: this.config.credentials.accountId as string | undefined,
      cfg: pluginCfg,
    });

    if (result.error) {
      throw new Error(result.error);
    }

    return { messageId: result.messageId || '' };
  }
}
