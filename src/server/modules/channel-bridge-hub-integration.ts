import { logger } from '../../core/logger.js';
/**
 * ChannelBridge MessageHub 集成
 *
 * 负责将 ChannelBridge 接入 MessageHub（按通道动态注册）
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import { createChannelBridgeInput } from '../../bridges/channel-bridge-input.js';
import { createChannelBridgeOutput } from '../../bridges/channel-bridge-output.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import type { ChannelMessage } from '../../bridges/types.js';

export interface ChannelBridgeHubIntegrationConfig {
  hub: MessageHub;
  channelBridgeManager: ChannelBridgeManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  channelId: string;
}

export class ChannelBridgeHubIntegration {
  private hub: MessageHub;
  private channelBridgeManager: ChannelBridgeManager;
  private dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  private inputModule: ReturnType<typeof createChannelBridgeInput> | null = null;
  private outputModule: ReturnType<typeof createChannelBridgeOutput> | null = null;
  private registered = false;
  private channelId: string;

  constructor(config: ChannelBridgeHubIntegrationConfig) {
    this.hub = config.hub;
    this.channelBridgeManager = config.channelBridgeManager;
    this.dispatchTaskToAgent = config.dispatchTaskToAgent;
    this.channelId = config.channelId;
  }

  /**
   * 注册 Input/Output 模块到 MessageHub
   */
  register(): void {
    if (this.registered) {
      logger.module('channel-bridge-hub-integration').info('Already registered', { channelId: this.channelId });
      return;
    }

    // 创建 Input 模块
    this.inputModule = createChannelBridgeInput({
      channelId: this.channelId,
      hub: this.hub,
      handler: this.handleMessage.bind(this),
    });

    // 创建 Output 模块
    this.outputModule = createChannelBridgeOutput({
      channelId: this.channelId,
      hub: this.hub,
      bridgeManager: this.channelBridgeManager,
    });

    // 注册到 MessageHub
    this.inputModule.register();
    this.outputModule.register();

    // 添加路由：将通道消息路由到 handler
    this.hub.addRoute({
      id: `channel-bridge-${this.channelId}-route`,
      pattern: `channel.${this.channelId}`,
      handler: async (message: unknown) => this.handleMessage(message as ChannelBridgeEnvelope),
      blocking: true,
      priority: 1,
    });

    this.registered = true;
    logger.module('channel-bridge-hub-integration').info('Registered to MessageHub', { channelId: this.channelId });
  }

  /**
   * 取消注册
   */
  unregister(): void {
    if (!this.registered) return;

    if (this.inputModule) {
      this.inputModule.unregister();
    }
    if (this.outputModule) {
      this.outputModule.unregister();
    }

    this.hub.removeRoute(`channel-bridge-${this.channelId}-route`);

    this.registered = false;
    logger.module('channel-bridge-hub-integration').info('Unregistered from MessageHub', { channelId: this.channelId });
  }

  /**
   * 处理 ChannelBridge.onMessage 回调
   */
  async handleInbound(message: ChannelMessage): Promise<unknown> {
    if (!this.inputModule) {
      throw new Error('ChannelBridgeHubIntegration not registered');
    }
    return this.inputModule.handleChannelMessage(message);
  }

  /**
   * 处理消息（Agent 处理逻辑）
   */
  private async handleMessage(envelope: ChannelBridgeEnvelope): Promise<unknown> {
    logger.module('channel-bridge-hub-integration').info('Handling message', {
      id: envelope.id,
      channelId: envelope.channelId,
      senderId: envelope.senderId,
      contentLength: envelope.content.length,
    });

    try {
      // 构造 dispatch request
      const dispatchRequest: AgentDispatchRequest = {
        sourceAgentId: 'channel-bridge',
        targetAgentId: 'finger-orchestrator',
        task: { prompt: envelope.content },
        sessionId: `channel-${this.channelId}-${envelope.senderId}`,
        metadata: {
          source: 'channel',
          channelId: envelope.channelId,
          senderId: envelope.senderId,
          senderName: envelope.senderName,
          messageId: envelope.id,
          type: envelope.type,
        },
        blocking: true,
        queueOnBusy: true,
        maxQueueWaitMs: 180000,
      };

      logger.module('channel-bridge-hub-integration').info('Dispatching to orchestrator', { channelId: this.channelId });
      const result = await this.dispatchTaskToAgent(dispatchRequest);

      // 处理回复
      if (result && typeof result === 'object' && 'ok' in result && result.ok && 'result' in result) {
        const replyText = typeof result.result === 'string'
          ? result.result
          : ((result.result as any)?.summary || '处理完成');

        logger.module('channel-bridge-hub-integration').info('Sending reply via output module', { channelId: this.channelId });
        
        // 通过 Output 模块发送回复
        if (this.outputModule) {
          await this.outputModule.sendReply(envelope, replyText);
        }
      }

      return result;
    } catch (error) {
      logger.module('channel-bridge-hub-integration').error('Error handling message:', undefined, { error });
      
      // 发送错误回复
      const errorMessage = `处理失败: ${error instanceof Error ? error.message : String(error)}`;
      if (this.outputModule) {
        await this.outputModule.sendReply(envelope, errorMessage);
      }
      
      throw error;
    }
  }

  /**
   * 是否已注册
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * 获取通道 ID
   */
  getChannelId(): string {
    return this.channelId;
  }
}

/**
 * ChannelBridge Hub 集成管理器（支持多通道动态注册）
 */
export class ChannelBridgeHubIntegrationManager {
  private hub: MessageHub;
  private channelBridgeManager: ChannelBridgeManager;
  private dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  private integrations: Map<string, ChannelBridgeHubIntegration> = new Map();

  constructor(config: {
    hub: MessageHub;
    channelBridgeManager: ChannelBridgeManager;
    dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  }) {
    this.hub = config.hub;
    this.channelBridgeManager = config.channelBridgeManager;
    this.dispatchTaskToAgent = config.dispatchTaskToAgent;
  }

  /**
   * 为通道注册 MessageHub 集成
   */
  registerChannel(channelId: string): void {
    if (this.integrations.has(channelId)) {
      logger.module('channel-bridge-hub-integration').info('Channel already registered', { channelId });
      return;
    }

    const integration = new ChannelBridgeHubIntegration({
      hub: this.hub,
      channelBridgeManager: this.channelBridgeManager,
      dispatchTaskToAgent: this.dispatchTaskToAgent,
      channelId,
    });

    integration.register();
    this.integrations.set(channelId, integration);
    logger.module('channel-bridge-hub-integration').info('Registered channel', { channelId });
  }

  /**
   * 取消注册通道
   */
  unregisterChannel(channelId: string): void {
    const integration = this.integrations.get(channelId);
    if (!integration) return;

    integration.unregister();
    this.integrations.delete(channelId);
    logger.module('channel-bridge-hub-integration').info('Unregistered channel', { channelId });
  }

  /**
   * 处理通道消息（动态路由）
   */
  async handleInbound(message: ChannelMessage): Promise<unknown> {
    const integration = this.integrations.get(message.channelId);
    if (!integration) {
      throw new Error(`No MessageHub integration for channel: ${message.channelId}`);
    }
    return integration.handleInbound(message);
  }

  /**
   * 注册多个通道
   */
  registerChannels(channelIds: string[]): void {
    for (const channelId of channelIds) {
      this.registerChannel(channelId);
    }
  }

  /**
   * 获取已注册通道列表
   */
  getRegisteredChannels(): string[] {
    return Array.from(this.integrations.keys());
  }
}
