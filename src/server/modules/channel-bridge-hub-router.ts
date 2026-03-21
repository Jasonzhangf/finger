import { logger } from '../../core/logger.js';
/**
 * ChannelBridge Hub Router - 根据配置动态选择路由方式
 *
 * 支持两种模式：
 * 1. useHub = false: 旧路径（ChannelBridge → dispatchTaskToAgent）
 * 2. useHub = true: 新路径（ChannelBridge ��� MessageHub → Agent → MessageHub → ChannelBridge）
 *
 * 通道只需配置权限，自动接入 MessageHub
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import { ChannelBridgeHubIntegrationManager } from './channel-bridge-hub-integration.js';
import type { ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';

export interface ChannelBridgeHubRouterConfig {
  useHub: boolean;
  hub: MessageHub;
  channelBridgeManager: ChannelBridgeManager;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
}

export interface ChannelBridgeRouteResult {
  status: 'routed' | 'bypassed';
  method: 'hub' | 'direct';
  channelId?: string;
}

export class ChannelBridgeHubRouter {
  private useHub: boolean;
  private hub: MessageHub;
  private channelBridgeManager: ChannelBridgeManager;
  private dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
  private hubIntegrationManager: ChannelBridgeHubIntegrationManager;

  constructor(config: ChannelBridgeHubRouterConfig) {
    this.useHub = config.useHub;
    this.hub = config.hub;
    this.channelBridgeManager = config.channelBridgeManager;
    this.dispatchTaskToAgent = config.dispatchTaskToAgent;
    
    // 初始化 MessageHub 集成管理器
    this.hubIntegrationManager = new ChannelBridgeHubIntegrationManager({
      hub: this.hub,
      channelBridgeManager: this.channelBridgeManager,
      dispatchTaskToAgent: this.dispatchTaskToAgent,
    });

    // 如果启用 hub，注册所有已加载的通道
    if (this.useHub) {
      this.registerLoadedChannels();
    }
  }

  /**
   * 路由通道消息（根据配置自动选择路径）
   */
  async routeMessage(msg: ChannelMessage): Promise<ChannelBridgeRouteResult> {
    if (this.useHub) {
      return this.routeViaHub(msg);
    } else {
      return this.routeBypass(msg);
    }
  }

  /**
   * 通过 MessageHub 路由（新路径）
   */
  private async routeViaHub(msg: ChannelMessage): Promise<ChannelBridgeRouteResult> {
    logger.module('channel-bridge-hub-router').info('Routing via MessageHub', {
      msgId: msg.id,
      channelId: msg.channelId,
      useHub: true,
    });

    try {
      // 动态注册通道（如果尚未注册）
      if (!this.hubIntegrationManager.getRegisteredChannels().includes(msg.channelId)) {
        this.hubIntegrationManager.registerChannel(msg.channelId);
      }

      // 通过 MessageHub 集成处理消息
      await this.hubIntegrationManager.handleInbound(msg);

      return { status: 'routed', method: 'hub', channelId: msg.channelId };
    } catch (error) {
      logger.module('channel-bridge-hub-router').error('Hub routing error:', undefined, { error });
      throw error;
    }
  }

  /**
   * 旁路（旧路径，返回 null 由调用方处理）
   */
  private async routeBypass(msg: ChannelMessage): Promise<ChannelBridgeRouteResult> {
    logger.module('channel-bridge-hub-router').info('Bypassing MessageHub', {
      msgId: msg.id,
      channelId: msg.channelId,
      useHub: false,
    });

    return { status: 'bypassed', method: 'direct', channelId: msg.channelId };
  }

  /**
   * 更新路由模式
   */
  setUseHub(useHub: boolean): void {
    const wasUsingHub = this.useHub;
    this.useHub = useHub;
    
    logger.module('channel-bridge-hub-router').info('Routing mode updated', { 
      was: wasUsingHub, 
      now: useHub 
    });

    // 如果切换到 hub 模式，注册已加载的通道
    if (useHub && !wasUsingHub) {
      this.registerLoadedChannels();
    }
  }

  /**
   * 获取当前路由模式
   */
  isUsingHub(): boolean {
    return this.useHub;
  }

  /**
   * 注册已加载的通道到 MessageHub
   */
  private registerLoadedChannels(): void {
    const runningBridges = this.channelBridgeManager.getRunningBridges();
    logger.module('channel-bridge-hub-router').info('Registering loaded channels', { 
      channels: runningBridges 
    });
    
    this.hubIntegrationManager.registerChannels(runningBridges);
  }

  /**
   * 获取已注册通道列表
   */
  getRegisteredChannels(): string[] {
    return this.hubIntegrationManager.getRegisteredChannels();
  }
}
