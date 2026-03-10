/**
 * OpenClaw Input - receive calls from OpenClaw Gate plugins
 */
import { BaseInput } from './base.js';
import { createMessage, type OpenClawChannelMeta } from '../core/schema.js';
import type { OpenClawConfig } from '../core/schema.js';
import http from 'http';

export class OpenClawInput extends BaseInput {
  id: string;
  private config: OpenClawConfig;
  private server: http.Server | null = null;

  constructor(id: string, config: OpenClawConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const url = new URL(this.config.gatewayUrl);
    const port = parseInt(url.port, 10) || 9997;
    const host = url.hostname || '0.0.0.0';

    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end('Method Not Allowed');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400).end('Invalid JSON');
        return;
      }

      if (this.emit) {
        // 尝试解析通道消息
        const channelMessage = this.tryParseChannelMessage(payload);
        let msg;

        if (channelMessage) {
          // 这是通道消息
          msg = createMessage('channel-message', channelMessage.payload, this.id, {
            channelMeta: channelMessage.meta,
          });
        } else {
          // 旧格式：openclaw-call
          msg = createMessage('openclaw-call', { payload, pluginId: (payload as Record<string, unknown>).pluginId }, this.id);
        }

        await this.emit(msg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } else {
        res.writeHead(500).end('No emitter');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        this.running = true;
        resolve();
      }).on('error', reject);
    });
    console.log(`[Input:${this.id}] OpenClaw listening on ${host}:${port}`);
  }

  /**
   * 尝试解析 OpenClaw 通道消息
   */
  private tryParseChannelMessage(payload: unknown): {
    payload: { text: string; attachments?: unknown[] };
    meta: OpenClawChannelMeta;
  } | null {
    const p = payload as Record<string, unknown>;
    
    // 检查是否是 QQ Bot 消息
    if (p.author && p.content && p.id && p.timestamp) {
      const author = p.author as Record<string, unknown>;
      const chatType = this.detectChatType(p);
      const senderId = this.getSenderId(p);
      const threadId = this.getThreadId(p, chatType);
      
      return {
        payload: {
          text: p.content as string,
          attachments: p.attachments as unknown[],
        },
        meta: {
          channelId: 'qqbot',
          accountId: 'default',
          senderId,
          senderName: (author.username ?? author.id) as string,
          chatType,
          threadId,
          messageId: p.id as string,
          originalTimestamp: parseInt(p.timestamp as string, 10),
        },
      };
    }
    
    // TODO: 支持更多通道类型 (Slack, Discord, etc.)
    return null;
  }

  private detectChatType(payload: Record<string, unknown>): "direct" | "group" | "channel" {
    if (payload.group_id || payload.group_openid) return "group";
    if (payload.guild_id || payload.channel_id) return "channel";
    return "direct";
  }

  private getSenderId(payload: Record<string, unknown>): string {
    const author = payload.author as Record<string, unknown>;
    if (author.union_openid) return author.union_openid as string;
    if (author.user_openid) return author.user_openid as string;
    if (author.member_openid) return author.member_openid as string;
    return (author.id as string) || "unknown";
  }

  private getThreadId(payload: Record<string, unknown>, chatType: "direct" | "group" | "channel"): string | undefined {
    if (chatType === "group") {
      return (payload.group_openid ?? payload.group_id) as string;
    }
    if (chatType === "channel") {
      return (payload.channel_id ?? payload.guild_id) as string;
    }
    // 私聊：使用发送者 ID 作为线程 ID
    return this.getSenderId(payload);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close(err => err ? reject(err) : resolve());
      });
      this.server = null;
    }
    this.running = false;
  }
}
