/**
 * Channel Bridge Input Module - 将 ChannelBridge 消息接入 MessageHub
 *
 * 职责：
 * - 监听 ChannelBridge.onMessage
 * - 转换为 ChannelBridgeEnvelope
 * - 通过 MessageHub.registerInput 注册为输入模块
 *
 * 注意：此模块在 Phase 1 仅供测试，不启用
 */

import type { MessageHub } from '../orchestration/message-hub.js';
import type { ChannelMessage } from './types.js';
import { toEnvelope, type ChannelBridgeEnvelope } from './envelope.js';
import { logger } from '../core/logger.js';

const log = logger.module('ChannelBridgeInput');

/**
 * ChannelBridge Input 配置
 */
export interface ChannelBridgeInputConfig {
  /** 通道 ID */
  channelId: string;
  /** MessageHub 实例 */
  hub: MessageHub;
  /** 消息处理器（由外部提供，通常是 mailbox 路由） */
  handler: (envelope: ChannelBridgeEnvelope) => Promise<unknown>;
}

/**
 * ChannelBridge Input 模块
 *
 * 将 ChannelBridge 的消息转换为 MessageHub 输入
 */
export class ChannelBridgeInputModule {
  readonly channelId: string;
  private hub: MessageHub;
  private handler: (envelope: ChannelBridgeEnvelope) => Promise<unknown>;
  private registered = false;

  constructor(config: ChannelBridgeInputConfig) {
    this.channelId = config.channelId;
    this.hub = config.hub;
    this.handler = config.handler;
  }

  /**
   * 注册为 MessageHub Input
   */
  register(): void {
    if (this.registered) {
      log.warn(`Already registered: ${this.channelId}`);
      return;
    }

    const inputId = `channel-bridge-${this.channelId}`;

    this.hub.registerInput(
      inputId,
      async (message: unknown) => {
        // 类型检查
        if (!this.isChannelMessage(message)) {
          log.warn('Received non-ChannelMessage', { message });
          return { error: 'Invalid message type' };
        }

        // 转换为 Envelope
        const envelope = toEnvelope(message);
        log.info('Processing channel message', {
          id: envelope.id,
          channelId: envelope.channelId,
          senderId: envelope.senderId,
        });

        // 调用处理器
        return this.handler(envelope);
      },
      [`channel.${this.channelId}`] // 路由标签
    );

    this.registered = true;
    log.info(`Registered as MessageHub input: ${inputId}`);
  }

  /**
   * 取消注册
   */
  unregister(): void {
    if (!this.registered) return;

    const inputId = `channel-bridge-${this.channelId}`;
    this.hub.unregisterInput(inputId);
    this.registered = false;
    log.info(`Unregistered from MessageHub: ${inputId}`);
  }

  /**
   * 处理 ChannelBridge.onMessage 回调
   *
   * 此方法供 ChannelBridge 调用，将消息转发到 MessageHub
   */
 async handleChannelMessage(message: ChannelMessage): Promise<unknown> {
   const envelope = toEnvelope(message);

   // 通过 MessageHub 发送
   return this.hub.send({
     type: `channel.${this.channelId}`,
     payload: envelope,
     meta: {
       source: this.channelId,
       id: envelope.id,
     },
   });
 }

  /**
   * 处理 ChannelBridge.onMessage 回调（测试用）
   *
   * 此方法供测试使用，将消息转换为 Envelope 并直接调用 handler
   */
  async handleChannelMessageDirect(message: ChannelMessage): Promise<unknown> {
    const envelope = toEnvelope(message);
    log.info('Handling channel message directly', {
      id: envelope.id,
      channelId: envelope.channelId,
      senderId: envelope.senderId,
    });

    // 直接调用 handler（不通过 hub.send）
    return this.handler(envelope);
  }
  /**
   * 类型守卫：检查是否为 ChannelMessage
   */
  private isChannelMessage(message: unknown): message is ChannelMessage {
    if (!message || typeof message !== 'object') return false;
    const msg = message as Record<string, unknown>;
    return (
      typeof msg.id === 'string' &&
      typeof msg.channelId === 'string' &&
      typeof msg.senderId === 'string' &&
      typeof msg.content === 'string'
    );
  }

  /**
   * 是否已注册
   */
  isRegistered(): boolean {
    return this.registered;
  }
}

/**
 * 创建 ChannelBridge Input 模块
 */
export function createChannelBridgeInput(
  config: ChannelBridgeInputConfig
): ChannelBridgeInputModule {
  return new ChannelBridgeInputModule(config);
}
