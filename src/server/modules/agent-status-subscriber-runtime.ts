/**
 * Agent Status Subscriber Runtime Helpers
 *
 * Extracted from agent-status-subscriber.ts to keep file under 500 lines.
 * Contains sendStatusUpdate and startCleanup logic.
 */

import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type {
  SessionEnvelopeMapping,
  WrappedStatusUpdate,
} from './agent-status-subscriber-types.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriber');

/**
 * Send status update to communication channel via MessageHub.
 */
export async function sendStatusUpdate(
  envelope: SessionEnvelopeMapping['envelope'],
  statusUpdate: WrappedStatusUpdate,
  messageHub: MessageHub,
): Promise<void> {
  try {
    log.info(`[AgentStatusSubscriber] Sending status update to channel ${envelope.channel}:`, {
      agent: statusUpdate.agent.agentName || statusUpdate.agent.agentId,
      status: statusUpdate.status.state,
      level: statusUpdate.display.level,
      task: statusUpdate.task.taskDescription,
    });

    const outputId = 'channel-bridge-' + envelope.channel;
    const originalEnvelope: ChannelBridgeEnvelope = {
      id: envelope.envelopeId,
      channelId: envelope.channel,
      accountId: 'default',
      type: envelope.groupId ? 'group' : 'direct',
      senderId: envelope.userId || 'unknown',
      senderName: 'user',
      content: '',
      timestamp: Date.now(),
      metadata: {
        messageId: envelope.envelopeId,
        ...(envelope.groupId ? { groupId: envelope.groupId } : {}),
      },
    };

    const text = `${statusUpdate.display.title}\n${statusUpdate.status.summary}`
      + (statusUpdate.display.subtitle ? `\n${statusUpdate.display.subtitle}` : '');

    const message = {
      channelId: envelope.channel,
      target: envelope.groupId ? `group:${envelope.groupId}` : (envelope.userId || 'unknown'),
      content: text,
      originalEnvelope,
      statusUpdate,
    };

    await messageHub.routeToOutput(outputId, message);
    log.debug('[AgentStatusSubscriber] Sent status update via MessageHub: ' + outputId);
  } catch (error) {
    log.error('[AgentStatusSubscriber] Failed to send status update:', error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Start periodic cleanup of expired session mappings.
 * Returns a cleanup function to stop the timer.
 */
export function startCleanup(
  sessionEnvelopeMap: Map<string, SessionEnvelopeMapping>,
  cleanupIntervalMs: number,
): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    const expired: string[] = [];

    for (const [sessionId, mapping] of sessionEnvelopeMap.entries()) {
      if (now - mapping.timestamp > cleanupIntervalMs) {
        expired.push(sessionId);
      }
    }

    expired.forEach(sessionId => sessionEnvelopeMap.delete(sessionId));

    if (expired.length > 0) {
      log.info(`[AgentStatusSubscriber] Cleaned up ${expired.length} expired session mappings`);
    }
  }, cleanupIntervalMs);

  return () => {
    clearInterval(timer);
  };
}
