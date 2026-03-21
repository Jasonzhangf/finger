/**
 * Channel Bridge Bootstrap
 *
 * Loads channel bridge configs from channels.json and registers
 * ChannelBridgeOutput modules for each enabled channel.
 */

import { logger } from '../../core/logger.js';
import fs from 'fs';
import path from 'path';
import { getChannelBridgeManager, type ChannelBridgeConfig } from '../../bridges/index.js';
import { createChannelBridgeOutput } from '../../bridges/channel-bridge-output.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';

const channelBridgeOutputs: Array<{ channelId: string; unregister: () => void }> = [];

export async function loadChannelBridgeConfigs(configDir?: string): Promise<void> {
  logger.module('channel-bridge-bootstrap').debug('loadChannelBridgeConfigs called');
  const effectiveConfigDir = configDir ?? FINGER_PATHS.config.dir;
  const channelsConfigPath = path.join(effectiveConfigDir, 'channels.json');
  let configs: ChannelBridgeConfig[] = [];

  try {
    if (fs.existsSync(channelsConfigPath)) {
      const raw = fs.readFileSync(channelsConfigPath, 'utf-8');
      const parsed = JSON.parse(raw);
      configs = parsed.channels || [];

      const enabledInDaemon = parsed.enabledInDaemon !== false;
      if (!enabledInDaemon) {
        logger.module('channel-bridge-bootstrap').info('Channel bridge disabled in daemon (enabledInDaemon: false), skipping load');
        logger.module('channel-bridge-bootstrap').info('Use "finger-gateway-bridge start" command to start channel bridge independently');
        return;
      }

      logger.module('channel-bridge-bootstrap').debug('Found channels config file', { count: configs.length });
    } else {
      logger.module('channel-bridge-bootstrap').debug('channels.json not found', { path: channelsConfigPath });
    }
  } catch (err) {
    logger.module('channel-bridge-bootstrap').warn('Failed to load channels config', err instanceof Error ? { message: err.message } : undefined);
  }

  if (configs.length > 0) {
    logger.module('channel-bridge-bootstrap').debug('Loading channel bridge configs...');
    const channelBridgeManager = getChannelBridgeManager();
    
    // Start bridges individually so one failure doesn't block others
    for (const config of configs) {
      channelBridgeManager.addConfig(config);
      if (config.enabled) {
        try {
          await channelBridgeManager.startBridge(config.id);
          logger.module('channel-bridge-bootstrap').info('Started bridge for channel', { channelId: config.channelId });
        } catch (bridgeErr) {
          // Log but continue - webui may not have a bridge module, but qqbot should still work
          logger.module('channel-bridge-bootstrap').warn('Failed to start bridge for channel (output still registered)', {
            channelId: config.channelId,
            error: bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr),
          });
        }
      }
    }
    
    // Always register MessageHub outputs for enabled channels
    // This is critical for routing reasoning/status updates back to channels
    try {
      await registerChannelBridgeOutputs(configs);
    } catch (outputErr) {
      logger.module('channel-bridge-bootstrap').error('Failed to register channel bridge outputs', undefined, {
        message: outputErr instanceof Error ? outputErr.message : String(outputErr),
      });
    }
  } else {
    logger.module('channel-bridge-bootstrap').debug('No channel bridge configs to load');
  }
}

export async function registerChannelBridgeOutputs(configs: ChannelBridgeConfig[]): Promise<void> {
  const registeredChannels = new Set<string>();
  for (const config of configs) {
    if (!config.enabled || !config.channelId) continue;

    if (registeredChannels.has(config.channelId)) continue;
    registeredChannels.add(config.channelId);

    const channelBridgeManager = getChannelBridgeManager();
    // Note: sharedMessageHub is imported lazily to avoid circular deps
    const { sharedMessageHub } = await import('../../orchestration/shared-instances.js');
    const outputModule = createChannelBridgeOutput({
      channelId: config.channelId,
      hub: sharedMessageHub,
      bridgeManager: channelBridgeManager,
    });

    outputModule.register();
    channelBridgeOutputs.push({
      channelId: config.channelId,
      unregister: () => outputModule.unregister(),
    });

    logger.module('channel-bridge-bootstrap').info('Registered ChannelBridgeOutput for channel', { channelId: config.channelId });
  }

  if (registeredChannels.size > 0) {
    logger.module('channel-bridge-bootstrap').info('Registered ChannelBridgeOutput total', { count: registeredChannels.size });
  }
}
