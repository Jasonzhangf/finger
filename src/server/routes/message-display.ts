import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { DisplayChannelRequest } from './message-types.js';
import { logger } from '../../core/logger.js';

export function normalizeDisplayChannels(input: unknown): DisplayChannelRequest[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (item && typeof item === 'object') ? (item as Record<string, unknown>) : null)
    .filter((item): item is Record<string, unknown> => !!item)
    .map((item) => ({
      channelId: typeof item.channelId === 'string' ? item.channelId : '',
      to: typeof item.to === 'string' ? item.to : '',
      replyTo: typeof item.replyTo === 'string' ? item.replyTo : undefined,
      prefix: typeof item.prefix === 'string' ? item.prefix : undefined,
    }))
    .filter((item) => item.channelId.length > 0 && item.to.length > 0);
}

export async function sendDisplayFanout(
  channelBridgeManager: ChannelBridgeManager,
  channels: DisplayChannelRequest[],
  content: string,
): Promise<void> {
  if (channels.length === 0) return;
  const results = await Promise.allSettled(channels.map(async (channel) => {
    const text = channel.prefix ? `${channel.prefix}${content}` : content;
    await channelBridgeManager.sendMessage(channel.channelId, {
      to: channel.to,
      text,
      ...(channel.replyTo ? { replyTo: channel.replyTo } : {}),
    });
  }));
  results.forEach((result, index) => {
    const channel = channels[index];
    if (result.status === 'fulfilled') {
      logger.module('message-display').info('Display fanout sent', {
        channelId: channel.channelId,
        to: channel.to,
      });
      return;
    }
    const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    logger.module('message-display').error('Display fanout failed', error, {
      channelId: channel.channelId,
      to: channel.to,
    });
  });
}

/**
 * 发送输入同步到指定的 channels（与 displayChannels 相同结构）
 * 当 inputSyncChannels 不为空时，将用户输入同步到其他渠道
 */
export async function sendInputSync(
  channelBridgeManager: ChannelBridgeManager,
  channels: DisplayChannelRequest[],
  content: string,
): Promise<void> {
  if (channels.length === 0) return;
  const results = await Promise.allSettled(channels.map(async (channel) => {
    const prefix = channel.prefix || '[输入同步] ';
    const text = `${prefix}${content}`;
    await channelBridgeManager.sendMessage(channel.channelId, {
      to: channel.to,
      text,
    });
  }));
  results.forEach((result, index) => {
    const channel = channels[index];
    if (result.status === 'rejected') {
      logger.module('message-display').error('Input sync failed', undefined, {
        channelId: channel.channelId,
        to: channel.to,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    } else {
      logger.module('message-display').info('Input sync sent', {
        channelId: channel.channelId,
        to: channel.to,
      });
    }
  });
}
