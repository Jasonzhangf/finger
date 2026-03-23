/**
 * OpenClaw Bridge Adapter - Adapts OpenClaw plugins to standard Channel Bridge interface.
 *
 * Account resolution: Some plugins (e.g. openclaw-weixin) expect ctx.account to be
 * pre-resolved with token/configured fields. The adapter attempts to use the plugin's
 * registered resolveAccount callback to populate these fields before calling startAccount.
 *
 * Credential handling by channel type:
 * - type=openclaw-plugin: Uses config.credentials + adapterConfig for bridge config.
 *   Auth tokens are read by the plugin from its own state directory.
 * - type=webui: No bridge adapter needed.
 * - type=builtin: Legacy / built-in channels.
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions } from './types.js';
import type { ChannelPluginHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { getChannelHandler } from '../blocks/openclaw-plugin-manager/openclaw-api-adapter.js';
import { logger } from '../core/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

/**
 * Try to resolve account data from the OpenClaw state directory.
 * For plugins like openclaw-weixin that store auth tokens in their own state dir.
 */
function tryResolveAccountFromState(channelId: string, accountId: string): Record<string, unknown> | null {
  if (!channelId || !accountId) return null;

  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
    || process.env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(os.homedir(), '.openclaw');

  const accountFile = path.join(stateDir, channelId, 'accounts', `${accountId}.json`);
  if (!fs.existsSync(accountFile)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(accountFile, 'utf-8'));
    return {
      ...raw,
      accountId,
      configured: Boolean(raw.token),
    };
  } catch {
    return null;
  }
}

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
        const pluginCfg = {
          channels: {
            [this.channelId]: {
              ...this.config.credentials,
              ...(this.config.options?.adapterConfig || {}),
            },
          },
        };

        // Build account: raw credentials + try to resolve from plugin state
        let account: Record<string, unknown> = {
          ...this.config.credentials,
          ...(this.config.options?.adapterConfig || {}),
        };

        // If account doesn't have 'configured' field, try to resolve from plugin state
        if (!('configured' in account) && account.accountId) {
          const resolved = tryResolveAccountFromState(this.channelId, String(account.accountId));
          if (resolved) {
            log.info(`[${this.id}] Resolved account from state: configured=${resolved.configured}`);
            account = { ...account, ...resolved };
          }
        }

        const ctx: GatewayContext = {
          callbacks: this.callbacks,
          account,
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
