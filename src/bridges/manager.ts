/**
 * Channel Bridge Manager - 动态加载和管理渠道桥接
 *
 * Standardized channel management:
 * - Channel type determines bridge adapter (openclaw-plugin / webui / builtin)
 * - Credentials structure varies by channel type
 * - Push settings control what content each channel receives
 * - Permissions control send/receive/control capabilities
 */

import type { ChannelBridge, ChannelBridgeConfig, ChannelBridgeCallbacks, ChannelType, PushSettings } from './types.js';
import { logger } from '../core/logger.js';

import { OpenClawBridgeAdapter } from './openclaw-adapter.js';
import { WeixinBridgeAdapter } from './weixin-adapter.js';

const log = logger.module('ChannelBridgeManager');

/** Default push settings applied when channel config omits a field */
const DEFAULT_PUSH_SETTINGS: PushSettings = {
  updateMode: 'progress',
  reasoning: false,
  bodyUpdates: false,
  statusUpdate: true,
  toolCalls: false,
  stepUpdates: true,
  stepBatch: 5,
  progressUpdates: true,
};

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
   * Register a bridge module (called by dynamically loaded plugins)
   */
  registerBridgeModule(module: BridgeModule): void {
    this.bridgeModules.set(module.channelId, module);
    log.info(`Registered bridge module: ${module.channelId}`);
  }

  /**
   * Unregister a bridge module
   */
  unregisterBridgeModule(channelId: string): void {
    this.bridgeModules.delete(channelId);
    log.info(`Unregistered bridge module: ${channelId}`);
  }

  /**
   * Add config without starting bridge
   */
  addConfig(config: ChannelBridgeConfig): void {
    this.configs.set(config.id, config);
  }

  /**
   * Get config for a channel
   */
  getConfig(channelId: string): ChannelBridgeConfig | undefined {
    for (const config of this.configs.values()) {
      if (config.channelId === channelId) {
        return config;
      }
    }
    return undefined;
  }

  /**
   * Get channel type for a channel
   */
  getChannelType(channelId: string): ChannelType {
    const config = this.getConfig(channelId);
    return config?.type ?? 'builtin';
  }

  /**
   * Get push settings for a channel with defaults applied.
   * This is the SINGLE SOURCE OF TRUTH for push settings resolution.
   */
  getPushSettings(channelId: string): PushSettings {
    const config = this.getConfig(channelId);
    const raw = config?.options?.pushSettings;
    return {
      updateMode: raw?.updateMode === 'command' || raw?.updateMode === 'both' || raw?.updateMode === 'progress'
        ? raw.updateMode
        : DEFAULT_PUSH_SETTINGS.updateMode,
      reasoning: raw?.reasoning ?? DEFAULT_PUSH_SETTINGS.reasoning,
      bodyUpdates: raw?.bodyUpdates ?? DEFAULT_PUSH_SETTINGS.bodyUpdates,
      statusUpdate: raw?.statusUpdate ?? DEFAULT_PUSH_SETTINGS.statusUpdate,
      toolCalls: raw?.toolCalls ?? DEFAULT_PUSH_SETTINGS.toolCalls,
      stepUpdates: raw?.stepUpdates ?? DEFAULT_PUSH_SETTINGS.stepUpdates,
      stepBatch: raw?.stepBatch ?? DEFAULT_PUSH_SETTINGS.stepBatch,
      progressUpdates: raw?.progressUpdates ?? DEFAULT_PUSH_SETTINGS.progressUpdates,
    };
  }

  /**
   * Check if a specific push setting is enabled for a channel.
   * Convenience method to avoid full getPushSettings call.
   */
  shouldPush(channelId: string, setting: keyof PushSettings): boolean {
    return !!this.getPushSettings(channelId)[setting];
  }

  /**
   * Load configs and start all enabled bridges
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
   * Start a specific bridge
   */
  async startBridge(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      throw new Error(`Bridge config not found: ${id}`);
    }

    let module = this.bridgeModules.get(config.channelId);

    // Built-in adapter fallback for known channel types
    if (!module && config.channelId === 'openclaw-weixin') {
      const bridge = new WeixinBridgeAdapter(config, this.callbacks);
      await bridge.start();
      this.bridges.set(id, bridge);
      log.info(`Started weixin bridge with built-in adapter: ${id}`);
      return;
    }

    if (!module) {
      throw new Error(`Bridge module not found for channel: ${config.channelId} (type: ${config.type})`);
    }

    const bridgeOrPromise = module.factory(config, this.callbacks);
    const bridge = bridgeOrPromise instanceof Promise ? await bridgeOrPromise : bridgeOrPromise;

    await bridge.start();
    this.bridges.set(id, bridge);

    log.info(`Started bridge: ${id} (channel: ${config.channelId}, type: ${config.type})`);
  }

  /**
   * Stop a specific bridge
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
   * Stop all bridges
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
   * Send message via a bridge
   */
  async sendMessage(bridgeId: string, options: import('./types.js').SendMessageOptions): Promise<{ messageId: string }> {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) {
      throw new Error(`Bridge not found: ${bridgeId}`);
    }
    const result = await bridge.sendMessage(options);

    // Optional cross-channel sync fanout (best-effort, primary send result is authoritative)
    try {
      await this.sendMirrors(bridgeId, options);
    } catch (err) {
      log.warn(`Mirror send failed for source ${bridgeId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }

  private async sendMirrors(
    sourceBridgeId: string,
    options: import('./types.js').SendMessageOptions,
  ): Promise<void> {
    const sourceConfig = this.configs.get(sourceBridgeId);
    const sync = sourceConfig?.options?.sync;
    if (!sync?.enabled) return;

    const rawTargets = Array.isArray(sync.targets)
      ? sync.targets.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : [];
    if (rawTargets.length === 0) return;

    const targetOverrides = sync.targetOverrides && typeof sync.targetOverrides === 'object'
      ? sync.targetOverrides
      : {};

    const seen = new Set<string>();
    for (const targetRef of rawTargets) {
      const resolvedBridgeIds = this.resolveBridgeIdsForSyncTarget(targetRef);
      for (const targetBridgeId of resolvedBridgeIds) {
        if (targetBridgeId === sourceBridgeId) continue;
        if (seen.has(targetBridgeId)) continue;
        seen.add(targetBridgeId);

        const targetBridge = this.bridges.get(targetBridgeId);
        if (!targetBridge) continue;

        const targetConfig = this.configs.get(targetBridgeId);
        const overrideTo = targetOverrides[targetBridgeId]
          ?? (targetConfig ? targetOverrides[targetConfig.channelId] : undefined);
        const to = typeof overrideTo === 'string' && overrideTo.trim().length > 0
          ? overrideTo.trim()
          : options.to;

        // Cross-channel mirror should not carry replyTo from another channel thread
        const mirroredOptions: import('./types.js').SendMessageOptions = {
          to,
          text: options.text,
          ...(Array.isArray(options.attachments) && options.attachments.length > 0
            ? { attachments: options.attachments }
            : {}),
        };

        await targetBridge.sendMessage(mirroredOptions);
        log.info('Mirrored channel message', {
          sourceBridgeId,
          targetBridgeId,
          sourceChannelId: sourceConfig?.channelId,
          targetChannelId: targetConfig?.channelId,
          hasAttachments: Array.isArray(options.attachments) && options.attachments.length > 0,
        });
      }
    }
  }

  private resolveBridgeIdsForSyncTarget(targetRef: string): string[] {
    const out: string[] = [];
    for (const [id, config] of this.configs.entries()) {
      if (id === targetRef || config.channelId === targetRef) {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Get all running bridge IDs
   */
  getRunningBridges(): string[] {
    return Array.from(this.bridges.entries())
      .filter(([, bridge]) => bridge.isRunning())
      .map(([id]) => id);
  }

  /**
   * Get bridge instance
   */
  getBridge(id: string): ChannelBridge | undefined {
    return this.bridges.get(id);
  }
}

// Global singleton
let managerInstance: ChannelBridgeManager | null = null;

export function getChannelBridgeManager(callbacks?: ChannelBridgeCallbacks): ChannelBridgeManager {
  if (!managerInstance) {
    if (!callbacks) {
      throw new Error('First call to getChannelBridgeManager requires callbacks');
    }
    managerInstance = new ChannelBridgeManager(callbacks);

    // Process pending handlers from plugins loaded before manager init
    const pendingHandlers = (globalThis as any).__pendingChannelHandlers;
    if (pendingHandlers && pendingHandlers instanceof Map) {
      for (const [channelId, handler] of pendingHandlers) {
        managerInstance.registerBridgeModule({
          id: `openclaw-${channelId}`,
          channelId,
          factory: (config: ChannelBridgeConfig, cb: ChannelBridgeCallbacks) => {
            return new OpenClawBridgeAdapter(config, cb);
          },
        });
      }
      pendingHandlers.clear();
    }
  }
  return managerInstance;
}

export type { SendMessageOptions } from './types.js';
