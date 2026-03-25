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
 *
 * CDN:
 * - Download: https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=...
 * - Upload: https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=...&filekey=...
 * - Encryption: AES-128-ECB
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions, ChannelAttachment } from './types.js';
import { logger } from '../core/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const log = logger.module('WeixinBridgeAdapter');

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

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
  ret?: number;
  msgs?: WeixinMessage[];
  sync_buf?: string;
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

interface GetUploadUrlResponse {
  ret?: number;
  upload_param?: string;
  errcode?: number;
  errmsg?: string;
}

// ---------- CDN Utilities ----------

/**
 * Parse AES key from base64 (handles both raw 16 bytes and hex-encoded 32 chars)
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`Invalid aes_key: expected 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`);
}

/**
 * AES-128-ECB decrypt
 */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * AES-128-ECB encrypt
 */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * Compute AES-128-ECB padded size
 */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Download and decrypt image from Weixin CDN
 */
async function downloadAndDecryptImage(
  encryptedQueryParam: string,
  aesKeyBase64: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64);
  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;

  log.debug(`[CDN] Downloading image from CDN: ${url.slice(0, 100)}...`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  log.debug(`[CDN] Downloaded ${encrypted.length} encrypted bytes`);

  const decrypted = decryptAesEcb(encrypted, key);
  log.debug(`[CDN] Decrypted to ${decrypted.length} bytes`);

  return decrypted;
}

/**
 * Upload image to Weixin CDN and return the encrypted query param
 */
async function uploadImageToCdn(
  imageBuffer: Buffer,
  toUserId: string,
  opts: { baseUrl: string; token: string },
): Promise<{ encryptQueryParam: string; aesKey: Buffer }> {
  const aesKey = crypto.randomBytes(16);
  const rawsize = imageBuffer.length;
  const rawfilemd5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');

  log.debug(`[CDN] Uploading image: rawsize=${rawsize}, filesize=${filesize}, filekey=${filekey}`);

  // 1. Get upload URL
  const uploadUrlResp = await weixinApiFetch(opts.baseUrl, 'ilink/bot/getuploadurl', {
    filekey,
    media_type: 1, // IMAGE
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
  }, opts.token);

  const uploadParam = (uploadUrlResp as GetUploadUrlResponse).upload_param;
  if (!uploadParam) {
    throw new Error('getUploadUrl returned no upload_param');
  }

  // 2. Encrypt and upload
  const ciphertext = encryptAesEcb(imageBuffer, aesKey);
  const uploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  log.debug(`[CDN] Uploading ${ciphertext.length} encrypted bytes to CDN`);

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  });

  if (!uploadRes.ok) {
    throw new Error(`CDN upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
  }

  const encryptQueryParam = uploadRes.headers.get('x-encrypted-param');
  if (!encryptQueryParam) {
    throw new Error('CDN upload response missing x-encrypted-param header');
  }

  log.debug(`[CDN] Upload complete, encryptQueryParam received`);

  return { encryptQueryParam, aesKey };
}

// ---------- API Utilities ----------

async function weixinApiFetch(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl.replace(/\/$/, '')}/${endpoint}`;
  const bodyStr = JSON.stringify(body);

  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${token.trim()}`,
      'X-WECHAT-UIN': uin,
    },
    body: bodyStr,
  });

  if (!res.ok) {
    throw new Error(`API ${endpoint} failed: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<Record<string, unknown>>;
}

// ---------- Adapter Class ----------

export class WeixinBridgeAdapter implements ChannelBridge {
  readonly id: string;
  readonly channelId: string;
  private config: ChannelBridgeConfig;
  private callbacks: ChannelBridgeCallbacks;
  private running = false;
  private abortController: AbortController | null = null;
  private account: WeixinAccount | null = null;
  private updateBuffer = '';

  constructor(config: ChannelBridgeConfig, callbacks: ChannelBridgeCallbacks) {
    this.id = config.id;
    this.channelId = config.channelId;
    this.config = config;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
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
        await this.sleep(5000);
      }
    }
  }

  private async pollUpdates(): Promise<void> {
    if (!this.account) return;

    const url = `${this.account.baseUrl.replace(/\/$/, '')}/ilink/bot/getupdates`;
    const pollBody = JSON.stringify({ get_updates_buf: this.updateBuffer });
    const headers = this.getHeaders(pollBody);

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

    if (data.errcode !== undefined) {
      if (data.errcode === -14) {
        log.error(`[${this.id}] Session timeout, need QR code login`);
        this.callbacks.onError(new Error('Weixin session timeout, need QR code login'));
      }
      return;
    }

    if (data.get_updates_buf) {
      this.updateBuffer = data.get_updates_buf;
    }

    if (data.msgs && data.msgs.length > 0) {
      for (const msg of data.msgs) {
        await this.handleMessage(msg);
      }
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== 1) return;

    const fromUserId = msg.from_user_id || '';
    const sessionId = msg.session_id || '';

    let text = '';
    const attachments: ChannelAttachment[] = [];

    if (msg.item_list) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item) {
          text += item.text_item.text;
        } else if (item.type === 2 && item.image_item) {
          // Download and decrypt image from CDN
          try {
            log.info(`[${this.id}] Downloading image from Weixin CDN...`);
            const imageBuffer = await downloadAndDecryptImage(
              item.image_item.encrypt_query_param,
              item.image_item.aes_key,
            );

            // Convert to base64 data URL for AI processing
            const base64 = imageBuffer.toString('base64');
            const dataUrl = `data:image/jpeg;base64,${base64}`;

            log.info(`[${this.id}] Image downloaded and converted to base64 (${imageBuffer.length} bytes)`);

            attachments.push({
              type: 'image',
              url: dataUrl,
              metadata: {
                encrypt_query_param: item.image_item.encrypt_query_param,
                aes_key: item.image_item.aes_key,
                size: imageBuffer.length,
              },
            });
          } catch (err) {
            log.error(`[${this.id}] Failed to download image: ${err instanceof Error ? err.message : String(err)}`);
            // Fall back to CDN reference
            attachments.push({
              type: 'image',
              url: `weixin-cdn:${item.image_item.encrypt_query_param}`,
              metadata: {
                aes_key: item.image_item.aes_key,
                encrypt_query_param: item.image_item.encrypt_query_param,
                download_error: err instanceof Error ? err.message : String(err),
              },
            });
          }
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

    log.info(`[${this.id}] Received message from ${fromUserId}: ${text.slice(0, 50)}${attachments.length ? ` (+${attachments.length} images)` : ''}`);

    await this.callbacks.onMessage(channelMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
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

    const itemList: WeixinMessageItem[] = [];

    // Add text
    if (options.text) {
      itemList.push({ type: 1, text_item: { text: options.text } });
    }

    // Handle images
    if (options.attachments && options.attachments.length > 0) {
      for (const att of options.attachments) {
        if (att.type === 'image') {
          // Case 1: Already uploaded weixin-cdn image (forwarding)
          if (att.url.startsWith('weixin-cdn:')) {
            const metadata = att.metadata as Record<string, unknown> | undefined;
            itemList.push({
              type: 2,
              image_item: {
                encrypt_query_param: (metadata?.encrypt_query_param as string) || att.url.slice(11),
                aes_key: (metadata?.aes_key as string) || '',
              },
            });
            continue;
          }

          // Case 2: Base64 data URL (from downloaded image)
          if (att.url.startsWith('data:image/')) {
            const base64Match = att.url.match(/^data:image\/[^;]+;base64,(.+)$/);
            if (base64Match) {
              try {
                const imageBuffer = Buffer.from(base64Match[1], 'base64');
                log.info(`[${this.id}] Uploading image to Weixin CDN (${imageBuffer.length} bytes)...`);

                const { encryptQueryParam, aesKey } = await uploadImageToCdn(
                  imageBuffer,
                  options.to,
                  { baseUrl: this.account.baseUrl, token: this.account.token },
                );

                itemList.push({
                  type: 2,
                  image_item: {
                    encrypt_query_param: encryptQueryParam,
                    aes_key: aesKey.toString('base64'),
                  },
                });

                log.info(`[${this.id}] Image uploaded to CDN`);
              } catch (err) {
                log.error(`[${this.id}] Failed to upload image: ${err instanceof Error ? err.message : String(err)}`);
              }
              continue;
            }
          }

          // Case 3: Local file path or http URL - download first
          if (att.url.startsWith('http://') || att.url.startsWith('https://') || att.url.startsWith('file://')) {
            try {
              let imageBuffer: Buffer;

              if (att.url.startsWith('file://')) {
                const filePath = decodeURIComponent(att.url.replace(/^file:\/\//, ''));
                imageBuffer = await readFile(filePath);
              } else {
                const res = await fetch(att.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                imageBuffer = Buffer.from(await res.arrayBuffer());
              }

              log.info(`[${this.id}] Uploading local image to Weixin CDN (${imageBuffer.length} bytes)...`);

              const { encryptQueryParam, aesKey } = await uploadImageToCdn(
                imageBuffer,
                options.to,
                { baseUrl: this.account.baseUrl, token: this.account.token },
              );

              itemList.push({
                type: 2,
                image_item: {
                  encrypt_query_param: encryptQueryParam,
                  aes_key: aesKey.toString('base64'),
                },
              });

              log.info(`[${this.id}] Image uploaded to CDN`);
            } catch (err) {
              log.error(`[${this.id}] Failed to upload local image: ${err instanceof Error ? err.message : String(err)}`);
            }
            continue;
          }
        }
      }
    }

    const sendBody = JSON.stringify({
      msg: {
        to_user_id: options.to,
        item_list: itemList,
      },
    });

    const url = `${this.account.baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(sendBody),
      body: sendBody,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as Record<string, unknown>;
    const messageId = String((data.msg as Record<string, unknown>)?.message_id || Date.now());

    log.info(`[${this.id}] Sent message to ${options.to}: ${options.text?.slice(0, 50)}...`);

    return { messageId };
  }

  private getHeaders(body?: string): Record<string, string> {
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
