/**
 * OpenClaw Output - send responses back to OpenClaw Gate plugins
 */
import { BaseOutput } from './base.js';
import type { Message, OpenClawChannelMeta } from '../core/schema.js';
import type { OpenClawConfig } from '../core/schema.js';
import http from 'http';
import { logger } from '../core/logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Openclaw');

const log = logger.module('Openclaw');

export class OpenClawOutput extends BaseOutput {
  id: string;
  private config: OpenClawConfig;

  constructor(id: string, config: OpenClawConfig) {
    super();
    this.id = id;
    this.config = config;
  }

  async start(): Promise<void> {
    this.running = true;
    clog.log(`[Output:${this.id}] OpenClaw output ready`);
  }

  async handle(message: Message): Promise<unknown> {
    // 检查是否有通道元数据
    const channelMeta = message.meta.channelMeta;
    if (!channelMeta) {
      clog.log(`[Output:${this.id}] No channel meta found, skipping`);
      return;
    }

    clog.log(`[Output:${this.id}] Handling message for channel: ${channelMeta.channelId}, chatType: ${channelMeta.chatType}`);

    // 根据通道元数据决定如何路由
    // 目前主要是结构化输出，为后续 OpenClaw 调用做准备
    // TODO: 实现真实的通道回复调用
    const responsePayload = this.buildResponsePayload(message, channelMeta);
    
    clog.log(`[Output:${this.id}] Response payload:`, JSON.stringify(responsePayload, null, 2));
    
    return responsePayload;
  }

  /**
   * 构建响应 payload，为后续真实通道调用做准备
   */
  private buildResponsePayload(message: Message, channelMeta: OpenClawChannelMeta): Record<string, unknown> {
    // 提取文本内容
    let text = '';
    if (typeof message.payload === 'string') {
      text = message.payload;
    } else if (typeof message.payload === 'object' && message.payload !== null) {
      const payload = message.payload as Record<string, unknown>;
      if (typeof payload.text === 'string') {
        text = payload.text;
      }
    }

    return {
      channelId: channelMeta.channelId,
      accountId: channelMeta.accountId,
      target: this.getTargetAddress(channelMeta),
      chatType: channelMeta.chatType,
      replyToMessageId: channelMeta.messageId,
      text,
    };
  }

  /**
   * 构建目标地址，根据通道类型不同
   */
  private getTargetAddress(channelMeta: OpenClawChannelMeta): string {
    switch (channelMeta.channelId) {
      case 'qqbot':
        return this.getQQBotTarget(channelMeta);
      // TODO: 支持更多通道类型
      default:
        return channelMeta.threadId ?? channelMeta.senderId;
    }
  }

  /**
   * QQ Bot 特定的目标地址构建
   */
  private getQQBotTarget(channelMeta: OpenClawChannelMeta): string {
    switch (channelMeta.chatType) {
      case 'direct':
        return `qqbot:c2c:${channelMeta.senderId}`;
      case 'group':
        return `qqbot:group:${channelMeta.threadId}`;
      case 'channel':
        return `qqbot:channel:${channelMeta.threadId}`;
      default:
        return `qqbot:c2c:${channelMeta.senderId}`;
    }
  }

  /**
   * 内部辅助方法：发送 HTTP 请求（预留）
   */
  private async sendHttpRequest(
    url: string,
    payload: unknown,
    timeoutMs: number = 30000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const body = JSON.stringify(payload);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: parseInt(urlObj.port, 10) || 80,
          path: urlObj.pathname,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve(data);
              }
            } else {
              reject(new Error(`OpenClaw callback failed: ${res.statusCode}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('OpenClaw callback timeout')); });
      req.write(body);
      req.end();
    });
  }
}
