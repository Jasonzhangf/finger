/**
 * Weixin Bridge Adapter - Direct HTTP API implementation for Weixin channel.
 *
 * Connects to Weixin via the ilink backend API. Reads auth tokens from
 * ~/.openclaw/openclaw-weixin/accounts/.
 *
 * Image receive: CDN download → AES-128-ECB decrypt → save to temp file → pass local path
 * Image send: read local file → AES-128-ECB encrypt → getUploadUrl → PUT to CDN → sendMessage
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelMessage, SendMessageOptions, ChannelAttachment } from './types.js';
import { logger } from '../core/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { FINGER_PATHS } from '../core/finger-paths.js';

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
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string };
    aeskey?: string;
    url?: string;
  };
}

interface GetUpdatesResponse {
  ret?: number;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
  errcode?: number;
  errmsg?: string;
}

// ---------- AES-128-ECB ----------

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

function aesEcbPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16;
}

/**
 * Parse AES key: `aeskey` field is raw hex string (32 chars → 16 bytes).
 * `media.aes_key` field is base64 of either 16 raw bytes or 32 hex chars.
 */
function parseAesKey(aeskeyHex: string | undefined, aesKeyBase64: string | undefined): Buffer | null {
  // Prefer aeskey (hex string)
  if (aeskeyHex) {
    const hex = aeskeyHex.replace(/\s/g, '');
    if (/^[0-9a-fA-F]{32}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }
  // Fallback to media.aes_key (base64)
  if (aesKeyBase64) {
    const decoded = Buffer.from(aesKeyBase64, 'base64');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
      return Buffer.from(decoded.toString('ascii'), 'hex');
    }
  }
  return null;
}

// ---------- CDN Download + Decrypt → temp file ----------

async function downloadDecryptToTemp(
  encryptedQueryParam: string,
  aeskeyHex: string | undefined,
  aesKeyBase64: string | undefined,
): Promise<string> {
  const key = parseAesKey(aeskeyHex, aesKeyBase64);
  if (!key) {
    throw new Error(`Cannot parse AES key: aeskey=${aeskeyHex?.slice(0, 8)} aes_key=${aesKeyBase64?.slice(0, 8)}`);
  }

  const cdnUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  log.info(`[CDN] Downloading from CDN...`);

  const res = await fetch(cdnUrl);
  if (!res.ok) {
    throw new Error(`CDN download failed: ${res.status} ${res.statusText}`);
  }

  const encrypted = Buffer.from(await res.arrayBuffer());
  log.info(`[CDN] Downloaded ${encrypted.length} encrypted bytes, decrypting...`);

  const decrypted = decryptAesEcb(encrypted, key);
  log.info(`[CDN] Decrypted to ${decrypted.length} bytes`);

  // Save to temp file (same pattern as qqbot: local file path as url)
  const tmpDir = path.join(FINGER_PATHS.tmp.dir, 'weixin-images');
  await mkdir(tmpDir, { recursive: true });
  const fileName = `weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  const filePath = path.join(tmpDir, fileName);
  await writeFile(filePath, decrypted);

  log.info(`[CDN] Saved to ${filePath}`);
  return filePath;
}

// ---------- CDN Upload ----------

async function uploadImageToCdn(
  imageBuffer: Buffer,
  toUserId: string,
  opts: { baseUrl: string; token: string },
): Promise<{ encryptQueryParam: string; aesKeyHex: string }> {
  const aesKey = crypto.randomBytes(16);
  const rawsize = imageBuffer.length;
  const rawfilemd5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');

  log.info(`[CDN] Getting upload URL: rawsize=${rawsize} filekey=${filekey}`);

  // getUploadUrl
  const apiBody = JSON.stringify({
    filekey,
    media_type: 1,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
  });

  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');

  const urlResp = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/ilink/bot/getuploadurl`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${opts.token.trim()}`,
      'X-WECHAT-UIN': uin,
    },
    body: apiBody,
  });

  if (!urlResp.ok) throw new Error(`getUploadUrl failed: ${urlResp.status}`);
  const urlData = await urlResp.json() as Record<string, unknown>;
  const uploadParam = urlData.upload_param as string | undefined;
  if (!uploadParam) throw new Error('getUploadUrl returned no upload_param');

  // Upload encrypted buffer to CDN
  const ciphertext = encryptAesEcb(imageBuffer, aesKey);
  const uploadUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

  log.info(`[CDN] Uploading ${ciphertext.length} encrypted bytes...`);

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(ciphertext),
  });

  if (!uploadRes.ok) throw new Error(`CDN upload failed: ${uploadRes.status}`);

  const encryptQueryParam = uploadRes.headers.get('x-encrypted-param');
  if (!encryptQueryParam) throw new Error('CDN upload response missing x-encrypted-param');

  log.info(`[CDN] Upload complete`);
  return { encryptQueryParam, aesKeyHex: aesKey.toString('hex') };
}

// ---------- Adapter ----------

export class WeixinBridgeAdapter implements ChannelBridge {
  readonly id: string;
  readonly channelId: string;
  private config: ChannelBridgeConfig;
  private callbacks: ChannelBridgeCallbacks;
  private running = false;
  private abortController: AbortController | null = null;
  private account: WeixinAccount | null = null;
  private updateBuffer = '';
  private contextTokenMap = new Map<string, string>();

  constructor(config: ChannelBridgeConfig, callbacks: ChannelBridgeCallbacks) {
    this.id = config.id;
    this.channelId = config.channelId;
    this.config = config;
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    const accountId = this.config.credentials?.accountId as string | undefined;
    if (!accountId) throw new Error(`[${this.id}] Missing accountId`);

    this.account = await this.loadAccount(accountId);
    if (!this.account) throw new Error(`[${this.id}] Account not found: ${accountId}`);

    log.info(`[${this.id}] Loaded account: userId=${this.account.userId}`);

    this.abortController = new AbortController();
    this.running = true;
    this.pollLoop();
    this.callbacks.onReady();
    log.info(`[${this.id}] Started weixin bridge`);
  }

  private async loadAccount(accountId: string): Promise<WeixinAccount | null> {
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
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
    const body = JSON.stringify({ get_updates_buf: this.updateBuffer });
    const headers = this.getHeaders(body);

    const response = await fetch(url, {
      method: 'POST', headers, body,
      signal: this.abortController?.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const data = (await response.json()) as GetUpdatesResponse;

    if (data.errcode === -14) {
      log.error(`[${this.id}] Session timeout, need QR login`);
      this.callbacks.onError(new Error('Weixin session timeout'));
      return;
    }

    if (data.get_updates_buf) this.updateBuffer = data.get_updates_buf;

    if (data.msgs?.length) {
      for (const msg of data.msgs) {
        await this.handleMessage(msg);
      }
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== 1) return;

    const fromUserId = msg.from_user_id || '';
    const sessionId = msg.session_id || '';

    // Store context_token for outbound replies
    if (msg.context_token && fromUserId) {
      this.contextTokenMap.set(fromUserId, msg.context_token);
    }

    let text = '';
    const attachments: ChannelAttachment[] = [];

    if (msg.item_list) {
      for (const item of msg.item_list) {
        if (item.type === 1 && item.text_item) {
          text += item.text_item.text;
        } else if (item.type === 2 && item.image_item) {
          const img = item.image_item;
          const encParam = img.media?.encrypt_query_param;
          const aeskeyHex = img.aeskey;
          const aesKeyBase64 = img.media?.aes_key;

          if (!encParam) {
            log.warn(`[${this.id}] Image item has no encrypt_query_param, skipping`);
            continue;
          }

          try {
            const localPath = await downloadDecryptToTemp(encParam, aeskeyHex, aesKeyBase64);
            attachments.push({
              type: 'image',
              url: localPath,
              filename: path.basename(localPath),
            });
          } catch (err) {
            log.error(`[${this.id}] Failed to download/decrypt image: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    if (!text && attachments.length === 0) {
      log.debug(`[${this.id}] Empty message from ${fromUserId}`);
      return;
    }

    if (!text) text = '请描述这张图片的内容。';

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

    log.info(`[${this.id}] Received from ${fromUserId}: ${text.slice(0, 50)}${attachments.length ? ` (+${attachments.length} images)` : ''}`);
    await this.callbacks.onMessage(channelMessage);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }
    log.info(`[${this.id}] Stopped weixin bridge`);
  }

  isRunning(): boolean { return this.running; }

  async sendMessage(options: SendMessageOptions): Promise<{ messageId: string }> {
    if (!this.account) throw new Error(`[${this.id}] Not connected`);

    const itemList: Array<Record<string, unknown>> = [];

    if (options.text) {
      itemList.push({ type: 1, text_item: { text: options.text } });
    }

    // Handle image attachments
    if (options.attachments?.length) {
      for (const att of options.attachments) {
        if (att.type !== 'image' || !att.url) continue;

        // Already a weixin-cdn reference (forwarding)
        if (att.url.startsWith('weixin-cdn:')) {
          const metadata = att.metadata as Record<string, unknown> | undefined;
          itemList.push({
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: (metadata?.encrypt_query_param as string) || att.url.slice(11),
              },
            },
          });
          continue;
        }

        // Read image from local file / data URL / HTTP URL
        let imageBuffer: Buffer | null = null;
        if (att.url.startsWith('data:image/')) {
          const match = att.url.match(/^data:image\/[^;]+;base64,(.+)$/);
          if (match) imageBuffer = Buffer.from(match[1], 'base64');
        } else if (att.url.startsWith('http://') || att.url.startsWith('https://')) {
          const res = await fetch(att.url);
          if (res.ok) imageBuffer = Buffer.from(await res.arrayBuffer());
        } else {
          const filePath = att.url.startsWith('file://')
            ? decodeURIComponent(att.url.replace(/^file:\/\//, ''))
            : att.url;
          try { imageBuffer = await readFile(filePath); } catch {}
        }

        if (!imageBuffer) {
          log.warn(`[${this.id}] Cannot read image: ${att.url.slice(0, 80)}`);
          continue;
        }

        try {
          const { encryptQueryParam, aesKeyHex } = await uploadImageToCdn(
            imageBuffer, options.to,
            { baseUrl: this.account.baseUrl, token: this.account.token },
          );
          itemList.push({
            type: 2,
            image_item: {
              media: { encrypt_query_param: encryptQueryParam },
              aeskey: aesKeyHex,
            },
          });
        } catch (err) {
          log.error(`[${this.id}] Failed to upload image: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Build send request body
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

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);

    const data = await response.json() as Record<string, unknown>;
    const msg = data.msg as Record<string, unknown> | undefined;
    const messageId = String(msg?.message_id || Date.now());

    log.info(`[${this.id}] Sent to ${options.to}: ${(options.text || '').slice(0, 50)}`);
    return { messageId };
  }

  private getHeaders(body?: string): Record<string, string> {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uin,
    };
    if (this.account?.token) h['Authorization'] = `Bearer ${this.account.token.trim()}`;
    if (body) h['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
    return h;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
