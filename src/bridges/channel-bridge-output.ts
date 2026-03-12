/**
 * Channel Bridge Output Module - 将 MessageHub 输出路由到 ChannelBridge
 *
 * 职责：
 * - 注册为 MessageHub Output
 * - 接收 Agent 回复
 * - 调用 ChannelBridge.sendMessage 发送回复
 *
 * ��意：此模块在 Phase 1 仅供测试，不启用
 */

import type { MessageHub } from '../orchestration/message-hub.js';
import type { ChannelBridgeManager } from './manager.js';
import type { ChannelBridgeEnvelope } from './envelope.js';
import { createSendOptions } from './envelope.js';
import { logger } from '../core/logger.js';

const log = logger.module('ChannelBridgeOutput');

/**
 * ChannelBridge Output 配置
 */
export interface ChannelBridgeOutputConfig {
  /** 通道 ID */
  channelId: string;
  /** MessageHub 实例 */
  hub: MessageHub;
  /** ChannelBridge Manager 实例 */
  bridgeManager: ChannelBridgeManager;
}

/**
 * 输出消息格式
 */
export interface ChannelOutputMessage {
  /** 目标通道 ID */
  channelId: string;
  /** 目标用户/群 ID */
  target: string;
  /** 回复内容 */
  content: string;
  /** 原始消息封套（用于 replyTo） */
  originalEnvelope: ChannelBridgeEnvelope;
}

/**
 * ChannelBridge Output 模块
 *
 * 将 MessageHub 的输出路由到 ChannelBridge
 */
export class ChannelBridgeOutputModule {
  readonly channelId: string;
  private hub: MessageHub;
  private bridgeManager: ChannelBridgeManager;
  private registered = false;

  constructor(config: ChannelBridgeOutputConfig) {
    this.channelId = config.channelId;
    this.hub = config.hub;
    this.bridgeManager = config.bridgeManager;
  }

  /**
   * 注册为 MessageHub Output
   */
  register(): void {
    if (this.registered) {
      log.warn(`Already registered: ${this.channelId}`);
      return;
    }

    const outputId = `channel-bridge-${this.channelId}`;

    this.hub.registerOutput(
      outputId,
      async (message: unknown, callback?: (result: unknown) => void) => {
        try {
          const result = await this.handleOutput(message);
          if (callback) callback(result);
          return result;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.error('Output handler error', error);
          if (callback) callback({ error: error.message });
          throw error;
        }
      }
    );

    this.registered = true;
    log.info(`Registered as MessageHub output: ${outputId}`);
  }

  /**
   * 取消注册
   */
  unregister(): void {
    if (!this.registered) return;

    const outputId = `channel-bridge-${this.channelId}`;
    this.hub.unregisterOutput(outputId);
    this.registered = false;
    log.info(`Unregistered from MessageHub: ${outputId}`);
  }

  /**
   * 处理输出消息
   */
  private async handleOutput(message: unknown): Promise<{ messageId: string }> {
    // 类型检查
    if (!this.isOutputMessage(message)) {
      throw new Error('Invalid output message format');
    }

    const output = message as ChannelOutputMessage;
    const envelope = output.originalEnvelope;

    log.info('Sending channel output', {
      channelId: output.channelId,
      target: output.target,
      contentLength: output.content.length,
      replyTo: envelope.metadata.messageId,
    });

    // 创建发送选项
    const sendOptions = createSendOptions(envelope, output.content);

    // 通过 ChannelBridge 发送
    const result = await this.bridgeManager.sendMessage(output.channelId, sendOptions);

    log.info('Channel output sent', {
      messageId: result.messageId,
      channelId: output.channelId,
    });

    return result;
  }

  /**
   * 发送回复到通道
   *
   * 公共方法，供外部调用
   */
  async sendReply(
    envelope: ChannelBridgeEnvelope,
    content: string
  ): Promise<{ messageId: string }> {
    const output: ChannelOutputMessage = {
      channelId: envelope.channelId,
      target: envelope.metadata.peerId || envelope.senderId,
      content,
      originalEnvelope: envelope,
    };

    return this.handleOutput(output);
  }

  /**
   * 类型守卫：检查是否为输出消息
   */
  private isOutputMessage(message: unknown): message is ChannelOutputMessage {
    if (!message || typeof message !== 'object') return false;
    const msg = message as Record<string, unknown>;
    return (
      typeof msg.channelId === 'string' &&
      typeof msg.target === 'string' &&
      typeof msg.content === 'string' &&
      !!msg.originalEnvelope
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
 * 创建 ChannelBridge Output 模块
 */
export function createChannelBridgeOutput(
  config: ChannelBridgeOutputConfig
): ChannelBridgeOutputModule {
  return new ChannelBridgeOutputModule(config);
}
