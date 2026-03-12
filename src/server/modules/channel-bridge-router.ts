/**
 * ChannelBridge Router - 根据配置开关选择路由方式
 *
 * 旧路由（默认）: ChannelBridge → dispatchTaskToAgent
 * 新路由: ChannelBridge → MessageHub → Agent → MessageHub → ChannelBridge
 */

import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelMessage } from '../../bridges/types.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';

export interface ChannelBridgeRouterConfig {
  useHub: boolean;
  hub: MessageHub;
  dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;
}

export interface ChannelBridgeRouterResult {
  status: 'success' | 'error';
  message?: string;
}

export class ChannelBridgeRouter {
  private useHub: boolean;
  private hub: MessageHub;
  private dispatchTaskToAgent: (request: AgentDispatchRequest) => Promise<unknown>;

  constructor(config: ChannelBridgeRouterConfig) {
    this.useHub = config.useHub;
    this.hub = config.hub;
    this.dispatchTaskToAgent = config.dispatchTaskToAgent;
  }

  /**
   * 路由通道消息
   */
  async routeMessage(msg: ChannelMessage): Promise<ChannelBridgeRouterResult> {
    if (this.useHub) {
      return this.routeViaHub(msg);
    } else {
      return this.routeDirect(msg);
    }
  }

  /**
   * 通过 MessageHub 路由（新路径）
   */
  private async routeViaHub(msg: ChannelMessage): Promise<ChannelBridgeRouterResult> {
    console.log('[ChannelBridgeRouter] Routing via MessageHub', {
      msgId: msg.id,
      channelId: msg.channelId,
      useHub: true,
    });

    try {
      // 将消息发送到 MessageHub，通过注册的 input handler 处理
      await this.hub.send({
        type: `channel.${msg.channelId}`,
        payload: msg,
        meta: {
          source: msg.channelId,
          id: msg.id,
        },
      });

      return { status: 'success', message: 'Message routed via MessageHub' };
    } catch (error) {
      console.error('[ChannelBridgeRouter] Hub routing error:', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 直接路由（旧路径）
   */
  private async routeDirect(msg: ChannelMessage): Promise<ChannelBridgeRouterResult> {
    console.log('[ChannelBridgeRouter] Routing directly to agent', {
      msgId: msg.id,
      channelId: msg.channelId,
      useHub: false,
    });

    // 返回 null 表示由调用方处理（保持现有逻辑）
    return { status: 'success', message: 'Use direct routing' };
  }

  /**
   * 更新路由模式
   */
  setUseHub(useHub: boolean): void {
    this.useHub = useHub;
    console.log('[ChannelBridgeRouter] Routing mode updated:', { useHub });
  }

  /**
   * 获取当前路由模式
   */
  isUsingHub(): boolean {
    return this.useHub;
  }
}
