/**
 * Channel Bridge Manager - 动态加载和管理渠道桥接
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelBridge as BridgeCallbacks } from './types.js';
import { logger } from '../core/logger.js';

import { OpenClawBridgeAdapter } from './openclaw-adapter.js';

const log = logger.module('ChannelBridgeManager');


export interface BridgeModule {
  id: string;
  channelId: string;
  factory: (config: ChannelBridgeConfig, callbacks: ChannelBridgeCallbacks) => ChannelBridge | Promise<ChannelBridge>;
}

export class ChannelBridgeManager {
  private bridges: Map<string, ChannelBridge> = new Map();
  private configs: Map<string, ChannelBridgeConfig> = new Map();
  private callbacks: ChannelBridgeCallbacks;
  private bridgeModules: Map<string, BridgeModule> = new Map();

  constructor(callbacks: ChannelBridgeCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * 注册桥接模块（动态加载的插件会调用此方法注册自己）
   */
  registerBridgeModule(module: BridgeModule): void {
    this.bridgeModules.set(module.channelId, module);
    log.info(`Registered bridge module: ${module.channelId}`);
  }

  /**
   * 取消注册桥接模块
   */
  unregisterBridgeModule(channelId: string): void {
    this.bridgeModules.delete(channelId);
    log.info(`Unregistered bridge module: ${channelId}`);
  }

  /**
   * 添加配置（不启动桥接）
   */
  addConfig(config: ChannelBridgeConfig): void {
    this.configs.set(config.id, config);
  }

  /**
   * 获取指定 channel 的配置
   */
  getConfig(channelId: string): ChannelBridgeConfig | undefined {
    // 先按 channelId 查找
    for (const config of this.configs.values()) {
      if (config.channelId === channelId) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * 获取指定 channel 的推送设置
   */
  getPushSettings(channelId: string): { reasoning: boolean; statusUpdate: boolean; toolCalls: boolean; stepUpdates: boolean; stepBatch: number } {
    const config = this.getConfig(channelId);
    const pushSettings = config?.options?.pushSettings as {
      reasoning?: boolean;
      statusUpdate?: boolean;
      toolCalls?: boolean;
      stepUpdates?: boolean;
      stepBatch?: number;
    } | undefined;
    return {
      reasoning: pushSettings?.reasoning ?? false,
      statusUpdate: pushSettings?.statusUpdate ?? true,
      toolCalls: pushSettings?.toolCalls ?? false,
      stepUpdates: pushSettings?.stepUpdates ?? false,
      stepBatch: pushSettings?.stepBatch ?? 5,
    };
  }

  /**
   * 加载配置并启动所有启用的桥接
   */
  async loadConfigs(configs: ChannelBridgeConfig[]): Promise<void> {
    for (const config of configs) {
      this.configs.set(config.id, config);
      if (config.enabled) {
        await this.startBridge(config.id);
      }
    }
  }

  /**
   * 启动指定桥接
   */
  async startBridge(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Bridge config not found: ${id}`);
    }

    // 查找对应的桥接模块
    const module = this.bridgeModules.get(config.channelId);
    if (!module) {
      throw new Error(`Bridge module not found for channel: ${config.channelId}`);
    }

    // 创建桥接实例（可能是 Promise）
    const bridgeOrPromise = module.factory(config, this.callbacks);
    const bridge = bridgeOrPromise instanceof Promise ? await bridgeOrPromise : bridgeOrPromise;
    
    // 启动
    await bridge.start();
    this.bridges.set(id, bridge);
    
    log.info(`Started bridge: ${id} (channel: ${config.channelId})`);
  }

  /**
   * 停止指定桥接
   */
  async stopBridge(id: string): Promise<void> {
    const bridge = this.bridges.get(id);
    if (bridge) {
      await bridge.stop();
      this.bridges.delete(id);
      log.info(`Stopped bridge: ${id}`);
    }
  }

  /**
   * 停止所有桥接
   */
  async stopAll(): Promise<void> {
    for (const [id, bridge] of this.bridges) {
      try {
        await bridge.stop();
        log.info(`Stopped bridge: ${id}`);
      } catch (err) {
        log.error(`Failed to stop bridge ${id}:`, err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.bridges.clear();
  }

  /**
   * 发送消息
   */
  async sendMessage(bridgeId: string, options: import('./types.js').SendMessageOptions): Promise<{ messageId: string }> {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) {
      throw new Error(`Bridge not found: ${bridgeId}`);
    }
    return bridge.sendMessage(options);
  }

  /**
   * 获取所有运行中的桥接
   */
  getRunningBridges(): string[] {
    return Array.from(this.bridges.entries())
      .filter(([, bridge]) => bridge.isRunning())
      .map(([id]) => id);
  }

  /**
   * 获取桥接实例
   */
  getBridge(id: string): ChannelBridge | undefined {
    return this.bridges.get(id);
  }
}

// 全局单例
let managerInstance: ChannelBridgeManager | null = null;

export function getChannelBridgeManager(callbacks?: ChannelBridgeCallbacks): ChannelBridgeManager {
  if (!managerInstance) {
    if (!callbacks) {
      throw new Error('First call to getChannelBridgeManager requires callbacks');
    }
    managerInstance = new ChannelBridgeManager(callbacks);
    
    // 处理之前存储的 pending handlers
    const pendingHandlers = (globalThis as any).__pendingChannelHandlers;
    if (pendingHandlers && pendingHandlers instanceof Map) {
      for (const [channelId, handler] of pendingHandlers) {
        managerInstance.registerBridgeModule({
          id: `openclaw-${channelId}`,
          channelId,
          factory: (config: any, callbacks: any) => {
            return new OpenClawBridgeAdapter(config, callbacks);
          },
        });
      }
      pendingHandlers.clear();
    }
  }
  return managerInstance;
}

export type { SendMessageOptions } from './types.js';
