import { logger } from '../../core/logger.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { MessageHub } from '../../orchestration/message-hub.js';

const log = logger.module('ChannelDeliveryRecovery');

const bridgeRecoveryInFlight = new Map<string, Promise<void>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function isOutputNotRegisteredError(error: unknown, outputId?: string): boolean {
  const message = errorMessage(error);
  if (!message) return false;
  if (outputId) return message.includes(`Output ${outputId} not registered`);
  return /Output\s+.+\s+not registered/i.test(message);
}

export function isBridgeNotFoundError(error: unknown, bridgeId?: string): boolean {
  const message = errorMessage(error);
  if (!message) return false;
  if (bridgeId) return message.includes(`Bridge not found: ${bridgeId}`);
  return /Bridge not found:/i.test(message);
}

export function isRecoverableDeliveryError(error: unknown, outputId?: string, channelId?: string): boolean {
  return isOutputNotRegisteredError(error, outputId)
    || isBridgeNotFoundError(error, channelId);
}

function isOutputRegistered(messageHub: MessageHub | undefined, outputId: string): boolean {
  if (!messageHub) return false;
  if (typeof (messageHub as { getOutputs?: unknown }).getOutputs !== 'function') return true;
  return messageHub.getOutputs().some((output) => output.id === outputId);
}

async function recoverBridgeIfNeeded(
  channelBridgeManager: ChannelBridgeManager,
  channelId: string,
): Promise<void> {
  const config = channelBridgeManager.getConfig(channelId);
  if (!config?.enabled) return;
  const lockKey = `${channelId}:${config.id}`;
  const inFlight = bridgeRecoveryInFlight.get(lockKey);
  if (inFlight) {
    await inFlight;
    return;
  }

  const task = (async () => {
    try {
      await channelBridgeManager.startBridge(config.id);
      log.info('Recovered channel bridge for delivery retry', {
        channelId,
        bridgeConfigId: config.id,
      });
    } catch (error) {
      log.warn('Failed to recover channel bridge', {
        channelId,
        bridgeConfigId: config.id,
        error: errorMessage(error),
      });
    }
  })();

  bridgeRecoveryInFlight.set(lockKey, task);
  try {
    await task;
  } finally {
    if (bridgeRecoveryInFlight.get(lockKey) === task) {
      bridgeRecoveryInFlight.delete(lockKey);
    }
  }
}

async function sendDirectWithBridgeRecovery(params: {
  channelBridgeManager: ChannelBridgeManager;
  channelId: string;
  target: string;
  text: string;
  replyTo?: string;
}): Promise<void> {
  const bridgeCandidates: string[] = [];
  bridgeCandidates.push(params.channelId);
  const config = params.channelBridgeManager.getConfig(params.channelId);
  if (config?.id && config.id !== params.channelId) {
    bridgeCandidates.push(config.id);
  }

  const attemptSend = async (): Promise<void> => {
    let lastError: unknown;
    for (const bridgeId of bridgeCandidates) {
      try {
        await params.channelBridgeManager.sendMessage(bridgeId, {
          to: params.target,
          text: params.text,
          ...(params.replyTo ? { replyTo: params.replyTo } : {}),
        });
        return;
      } catch (error) {
        lastError = error;
        if (!isBridgeNotFoundError(error, bridgeId)) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'bridge not found'));
  };

  try {
    await attemptSend();
    return;
  } catch (error) {
    if (!isBridgeNotFoundError(error)) throw error;
    await recoverBridgeIfNeeded(params.channelBridgeManager, params.channelId);
    await attemptSend();
  }
}

export async function routeToOutputWithRecovery(params: {
  messageHub?: MessageHub;
  channelBridgeManager?: ChannelBridgeManager;
  outputId: string;
  channelId: string;
  directTarget: string;
  text: string;
  replyTo?: string;
  messageFactory: () => unknown;
}): Promise<void> {
  const canRouteViaOutput = params.messageHub && isOutputRegistered(params.messageHub, params.outputId);

  if (canRouteViaOutput) {
    try {
      await params.messageHub!.routeToOutput(params.outputId, params.messageFactory());
      return;
    } catch (error) {
      if (!isRecoverableDeliveryError(error, params.outputId, params.channelId) || !params.channelBridgeManager) {
        throw error;
      }
      log.warn('routeToOutput failed; falling back to direct bridge send', {
        outputId: params.outputId,
        channelId: params.channelId,
        error: errorMessage(error),
      });
    }
  }

  if (!params.channelBridgeManager) {
    throw new Error(`Output ${params.outputId} not registered and channelBridgeManager unavailable`);
  }

  await sendDirectWithBridgeRecovery({
    channelBridgeManager: params.channelBridgeManager,
    channelId: params.channelId,
    target: params.directTarget,
    text: params.text,
    replyTo: params.replyTo,
  });
}
