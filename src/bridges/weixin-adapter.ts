/**
 * Weixin Bridge Adapter - Direct HTTP API implementation for Weixin channel.
 *
 * This adapter connects to Weixin via the ilink backend API without needing
 * the openclaw-weixin plugin to be loadable. It reads auth tokens from the
 * standard openclaw state directory (~/.openclaw/openclaw-weixin/accounts/).
 *
 * API Reference:
 * - getUpdates: Long-poll for new messages
 * - sendMessage: Send text/image/video/file messages
 * - getUploadUrl: Get CDN upload pre-signed URL
 * - sendTyping: Send typing indicator
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions, ChannelAttachment } from './types.js';
import { logger } from '../core/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const log = logger.module('WeixinBridgeAdapter');

interface WeixinAccount {
  token: string;
  baseUrl: string;
  userId: string;
  savedAt: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number; // 1=USER, 2=BOT
  message_state?: number; // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface WeixinMessageItem {
  type: number; // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  text_item?: { text: string };
  image_item?: {
    encrypt_query_param: string;
    aes_key: string;
  };
}

interface GetUpdatesResponse {
  ret: number;
  msgs?: WeixinMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

export class WeixinBridgeAdapter implements ChannelBridge {
  readonly id: string;
  readonly channelId: string;
  private config: ChannelBridgeConfig;
  private callbacks: ChannelBridgeCallbacks;
  private running = false;
  private abortController: AbortController | null = null;
  private account: WeixinAccount | null = null;
  private updateBuffer = '';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ChannelBridgeConfig, callbacks: ChannelBridgeCallbacks) {
    this.id = config.id;
    this.channelId = config.channelId;
    this.config = config;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    // Load account from state
    const accountId = this.config.credentials?.accountId as string | undefined;
    if (!accountId) {
      throw new Error(`[${this.id}] Missing accountId in credentials`);
    }

    this.account = await this.loadAccount(accountId);
    if (!this.account) {
      throw new Error(`[${this.id}] Failed to load account: ${accountId}`);
    }

    log.info(`[${this.id}] Loaded account: userId=${this.account.userId}`);

    this.abortController = new AbortController();
    this.running = true;

    // Start polling
    this.pollLoop();

    this.callbacks.onReady();
    log.info(`[${this.id}] Started weixin bridge`);
  }

  private async loadAccount(accountId: string): Promise<WeixinAccount | null> {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
      || path.join(os.homedir(), '.openclaw');

    const accountFile = path.join(stateDir, 'openclaw-weixin', 'accounts', `${accountId}.json`);
    if (!fs.existsSync(accountFile)) {
      log.error(`Account file not found: ${accountFile}`);
      return null;
    }

    try {
      const raw = await readFile(accountFile, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      log.error(`Failed to load account: ${err}`);
      return null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.abortController?.signal.aborted) {
      try {
        await this.pollUpdates();
      } catch (err) {
        log.error(`[${this.id}] Poll error: ${err instanceof Error ? err.message : String(err)}`);
        // Wait before retrying
        await this.sleep(5000);
      }
    }
  }

  private async pollUpdates(): Promise<void> {
    if (!this.account) return;

    const url = `${this.account.baseUrl.replace(/\/$/, '')}/ilink/bot/getupdates`;
    const pollBody = JSON.stringify({
      get_updates_buf: this.updateBuffer,
    });
    const headers = this.getHeaders(pollBody);

    log.debug(`[${this.id}] Polling updates...`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: pollBody,
      signal: this.abortController?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as GetUpdatesResponse;

    log.warn(`[${this.id}] getUpdates raw response: ${JSON.stringify(data).slice(0, 500)}`);
    
    if (data.ret !== undefined && data.ret !== 0) {
      // Session timeout, need to re-login
      if (data.errcode === -14) {
        log.error(`[${this.id}] Session timeout, need QR code login`);
        this.callbacks.onError(new Error('Weixin session timeout, need QR code login'));
      }
      return;
    }

    // Update cursor
    if (data.get_updates_buf) {
      this.updateBuffer = data.get_updates_buf;
    }

    // Process messages
    if (data.msgs && data.msgs.length > 0) {
      for (const msg of data.msgs) {
        await this.handleMessage(msg);
      }
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    // Only handle USER messages (type 1)
    if (msg.message_type !== 1) return;

    const fromUserId = msg.from_user_id || '';
    const sessionId = msg.session_id || '';

    // Extract text content
    let text = '';
    const attachments: ChannelAttachment[] = [];

    if (msg.item_list) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item) {
          text += item.text_item.text;
        } else if (item.type === 2 && item.image_item) {
          // Image - need to download via CDN
          attachments.push({
            type: 'image',
            url: `weixin-cdn:${item.image_item.encrypt_query_param}`,
            metadata: {
              aes_key: item.image_item.aes_key,
              encrypt_query_param: item.image_item.encrypt_query_param,
            },
          });
        }
      }
    }

    if (!text && attachments.length === 0) {
      log.debug(`[${this.id}] Empty message from ${fromUserId}`);
      return;
    }

    const channelMessage: ChannelMessage = {
      id: String(msg.message_id || Date.now()),
      channelId: this.channelId,
      accountId: this.config.credentials?.accountId as string || '',
      type: 'direct',
      senderId: fromUserId,
      content: text,
      timestamp: msg.create_time_ms || Date.now(),
      threadId: sessionId,
      replyTo: msg.context_token,
      attachments: attachments.length > 0 ? attachments : undefined,
      metadata: {
        context_token: msg.context_token,
        from_user_id: fromUserId,
      },
    };

    log.info(`[${this.id}] Received message from ${fromUserId}: ${text.slice(0, 50)}...`);

    await this.callbacks.onMessage(channelMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    log.info(`[${this.id}] Stopped weixin bridge`);
  }

  isRunning(): boolean {
    return this.running;
  }

  async sendMessage(options: SendMessageOptions): Promise<{ messageId: string }> {
    if (!this.account) {
      throw new Error(`[${this.id}] Not connected`);
    }

    const url = `${this.account.baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;
    const headers = this.getHeaders();

    // Build message items
    const itemList: WeixinMessageItem[] = [];

    // Add text
    if (options.text) {
      itemList.push({
        type: 1,
        text_item: { text: options.text },
      });
    }

    // Add images (TODO: implement CDN upload for local images)
    if (options.attachments && options.attachments.length > 0) {
      for (const att of options.attachments) {
        if (att.type === 'image' && att.url.startsWith('weixin-cdn:')) {
          // Already uploaded image (forwarding)
          const metadata = att.metadata as any;
          itemList.push({
            type: 2,
            image_item: {
              encrypt_query_param: metadata?.encrypt_query_param || att.url.slice(11),
              aes_key: metadata?.aes_key || '',
            },
          });
        }
        // Local images need CDN upload (TODO)
      }
    }

    const sendBody = JSON.stringify({
      msg: {
        to_user_id: options.to,
        item_list: itemList,
      },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(sendBody),
      body: sendBody,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as any;
    const messageId = String(data?.msg?.message_id || Date.now());

    log.info(`[${this.id}] Sent message to ${options.to}: ${options.text.slice(0, 50)}...`);

    return { messageId };
  }

  private getHeaders(body?: string): Record<string, string> {
    // X-WECHAT-UIN: random uint32 (big-endian) -> decimal string -> base64
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uin,
    };
    if (this.account?.token) {
      headers['Authorization'] = `Bearer ${this.account.token.trim()}`;
    }
    if (body) {
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
    }
    return headers;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
