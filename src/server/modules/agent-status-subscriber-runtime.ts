/**
 * Agent Status Subscriber Runtime Helpers
 *
 * Extracted from agent-status-subscriber.ts to keep file under 500 lines.
 * Contains sendStatusUpdate and startCleanup logic.
 *
 * IMPORTANT: All status update paths must check pushSettings before sending.
 * The ChannelBridgeManager.getPushSettings() is the single source of truth.
 */

import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { PushSettings } from '../../bridges/types.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import {
  enqueueUpdateStreamDelivery,
  enqueueUpdateStreamDeliveryNonBlocking,
} from './update-stream-delivery-adapter.js';
import { sanitizeUserFacingStatusTextWithOptions } from './agent-status-subscriber-handler-helpers.js';
import type {
  SessionEnvelopeMapping,
  WrappedStatusUpdate,
} from './agent-status-subscriber-types.js';
import { logger } from '../../core/logger.js';
import { routeToOutputWithRecovery } from './channel-delivery-recovery.js';

const log = logger.module('AgentStatusSubscriber');

type ContextDisplayMode = 'on' | 'off' | 'simple' | 'verbose';
interface ChannelDisplaySettings {
  context: ContextDisplayMode;
  heartbeat: boolean;
}

function normalizeLineForDedup(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}[]+/gu, '')
    .trim()
    .toLowerCase();
}

function joinUniqueLines(parts: Array<string | undefined>): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const text = sanitizeUserFacingStatusTextWithOptions(typeof raw === 'string' ? raw : '', {
      max: 12_000,
      singleLine: false,
    });
    if (!text) continue;
    const key = normalizeLineForDedup(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.join('\n');
}

function resolveChannelDisplaySettings(
  channelBridgeManager: ChannelBridgeManager | undefined,
  channelId: string,
): ChannelDisplaySettings {
  if (
    !channelBridgeManager
    || typeof (channelBridgeManager as { getConfig?: unknown }).getConfig !== 'function'
  ) {
    return { context: 'on', heartbeat: true };
  }
  const config = channelBridgeManager.getConfig(channelId);
  const options = (config?.options && typeof config.options === 'object')
    ? config.options as Record<string, unknown>
    : {};
  const displaySettings = (options.displaySettings && typeof options.displaySettings === 'object')
    ? options.displaySettings as Record<string, unknown>
    : {};
  const contextRaw = typeof displaySettings.context === 'string'
    ? displaySettings.context.trim().toLowerCase()
    : '';
  const context = contextRaw === 'off' || contextRaw === 'simple' || contextRaw === 'verbose' || contextRaw === 'on'
    ? contextRaw
    : 'on';
  const heartbeat = typeof displaySettings.heartbeat === 'boolean'
    ? displaySettings.heartbeat
    : true;
  return {
    context,
    heartbeat,
  };
}

function isHeartbeatLikeStatusUpdate(statusUpdate: WrappedStatusUpdate): boolean {
  const summary = typeof statusUpdate?.status?.summary === 'string' ? statusUpdate.status.summary : '';
  if (/\[[a-z]+:hb\]/i.test(summary) || /\[system agent:hb\]/i.test(summary)) {
    return true;
  }
  const details = (statusUpdate?.status?.details && typeof statusUpdate.status.details === 'object')
    ? statusUpdate.status.details as Record<string, unknown>
    : {};
  const sourceType = typeof details.sourceType === 'string' ? details.sourceType.trim().toLowerCase() : '';
  return sourceType === 'heartbeat'
    || sourceType === 'cron'
    || sourceType === 'mailbox'
    || sourceType === 'system-inject';
}

function applyContextDisplayMode(text: string, modeRaw: ContextDisplayMode): string {
  const segments = text
    .split(/(?=📊|👤|🗂|🤖|📬|✅|❌|⏳|🧠|🧩|🧪)/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const mode: ContextDisplayMode = modeRaw === 'on' ? 'simple' : modeRaw;
  if (mode === 'verbose') return text;
  const isContextLine = (line: string): boolean => {
    const normalized = line.trim();
    return normalized.startsWith('🧠 上下文:')
      || normalized.startsWith('🧩 构成')
      || normalized.startsWith('🧪 校验');
  };
  if (mode === 'off') {
    return segments.filter((line) => !isContextLine(line)).join('\n').trim();
  }
  if (mode === 'simple') {
    const output: string[] = [];
    let contextHeadlineAdded = false;
    let historyOnlyAdded = false;
    const historyRegex = /H\(c=[^)]+,cur=[^)]+\)/;
    const historySplitRegex = /H\(c=([^,]+),cur=([^)]+)\)/;
    for (const line of segments) {
      if (!isContextLine(line)) {
        output.push(line);
        continue;
      }
      const normalized = line.trim();
      if (normalized.startsWith('🧠 上下文:') && !contextHeadlineAdded) {
        output.push(line);
        contextHeadlineAdded = true;
        continue;
      }
      if (!historyOnlyAdded && normalized.startsWith('🧩 构成:') && historyRegex.test(normalized)) {
        const splitMatch = normalized.match(historySplitRegex);
        if (splitMatch && splitMatch[1] && splitMatch[2]) {
          const contextHistory = splitMatch[1].trim();
          const currentHistory = splitMatch[2].trim();
          output.push(`🧩 历史: context history=${contextHistory} · current history=${currentHistory}`);
          historyOnlyAdded = true;
          continue;
        }
        const match = normalized.match(historyRegex);
        if (match && match[0]) {
          output.push(`🧩 历史: ${match[0]}`);
          historyOnlyAdded = true;
        }
      }
    }
    return output.join('\n').trim();
  }
  const output: string[] = [];
  let contextHeadlineAdded = false;
  let contextSummaryAdded = false;
  for (const line of segments) {
    if (!isContextLine(line)) {
      output.push(line);
      continue;
    }
    const normalized = line.trim();
    if (normalized.startsWith('🧠 上下文:') && !contextHeadlineAdded) {
      output.push(line);
      contextHeadlineAdded = true;
      continue;
    }
    if (normalized.startsWith('🧩 构成: H(') && !contextSummaryAdded) {
      output.push(line);
      contextSummaryAdded = true;
      continue;
    }
  }
  return output.join('\n').trim();
}

/**
 * Check if a specific push setting is enabled for a channel.
 * Centralizes all pushSettings checks in one place.
 */
function shouldPush(
  channelBridgeManager: ChannelBridgeManager | undefined,
  channelId: string,
  setting: keyof PushSettings,
): boolean {
  if (!channelBridgeManager) return true; // no manager = push everything
  return !!channelBridgeManager.getPushSettings(channelId)[setting];
}

/**
 * Send status update to communication channel via MessageHub.
 * Filters based on pushSettings.statusUpdate.
 */
export async function sendStatusUpdate(
  envelope: SessionEnvelopeMapping['envelope'] | SessionEnvelopeMapping['envelope'][],
  statusUpdate: WrappedStatusUpdate,
  messageHub: MessageHub,
  channelBridgeManager?: ChannelBridgeManager,
  options?: {
    nonBlocking?: boolean;
  },
): Promise<void> {
  const envelopes = Array.isArray(envelope) ? envelope : [envelope];
  if (envelopes.length === 0) return;

  // Dedup by actual delivery target to avoid duplicate pushes when a session
  // has multiple observer envelopes (same channel/user/group but different envelopeId).
  const dedupedByTarget = new Map<string, SessionEnvelopeMapping['envelope']>();
  for (const item of envelopes) {
    const targetKey = `${item.channel}::${item.groupId ?? ''}::${item.userId ?? ''}`;
    dedupedByTarget.set(targetKey, item); // keep latest envelope for reply threading
  }
  const dedupedEnvelopes = Array.from(dedupedByTarget.values());

  for (const item of dedupedEnvelopes) {
    const channel = item.channel;

    if (!shouldPush(channelBridgeManager, channel, 'statusUpdate')) {
      log.debug(`[AgentStatusSubscriber] Skipping status update for ${channel} (statusUpdate disabled)`);
      continue;
    }
    const displaySettings = resolveChannelDisplaySettings(channelBridgeManager, channel);
    if (!displaySettings.heartbeat && isHeartbeatLikeStatusUpdate(statusUpdate)) {
      log.debug(`[AgentStatusSubscriber] Skipping heartbeat-like status update for ${channel} (displaySettings.heartbeat=false)`);
      continue;
    }

    try {
      log.info(`[AgentStatusSubscriber] Sending status update to channel ${channel}:`, {
        agent: statusUpdate.agent.agentName || statusUpdate.agent.agentId,
        status: statusUpdate.status.state,
        level: statusUpdate.display.level,
        task: statusUpdate.task.taskDescription,
      });

      const outputId = 'channel-bridge-' + channel;
      const originalEnvelope: ChannelBridgeEnvelope = {
        id: item.envelopeId,
        channelId: channel,
        accountId: 'default',
        type: item.groupId ? 'group' : 'direct',
        senderId: item.userId || 'unknown',
        senderName: 'user',
        content: '',
        timestamp: Date.now(),
        metadata: {
          messageId: item.envelopeId,
          ...(item.groupId ? { groupId: item.groupId } : {}),
        },
      };

      const text = joinUniqueLines([
        statusUpdate.display.title,
        statusUpdate.status.summary,
        statusUpdate.display.subtitle,
      ]);
      const displayText = applyContextDisplayMode(text, displaySettings.context);
      if (!displayText) {
        log.debug(`[AgentStatusSubscriber] Empty status text after display filtering for ${channel}`);
        continue;
      }

      const message = {
        channelId: channel,
        target: item.groupId ? `group:${item.groupId}` : (item.userId || 'unknown'),
        content: displayText,
        originalEnvelope,
        statusUpdate,
      };
      const directTarget = item.groupId ? `group:${item.groupId}` : (item.userId || 'unknown');

      const deliveryRouteKey = `${channel}::${item.groupId ?? ''}::${item.userId ?? ''}`;
      const dedupSignature = `${statusUpdate.sessionId}|${statusUpdate.agent.agentId}|status|${displayText}|${statusUpdate.status.state}|${statusUpdate.task.taskDescription}`;

      const request = {
        routeKey: deliveryRouteKey,
        dedupSignature,
        send: async () => {
          await routeToOutputWithRecovery({
            messageHub,
            channelBridgeManager,
            outputId,
            channelId: channel,
            directTarget,
            text: displayText,
            ...(item.envelopeId ? { replyTo: item.envelopeId } : {}),
            messageFactory: () => message,
          });
        },
        meta: {
          channelId: channel,
          sessionId: statusUpdate.sessionId,
          agentId: statusUpdate.agent.agentId,
          updateType: channelBridgeManager ? 'status' : 'status-output-only',
        },
      };
      if (options?.nonBlocking) {
        enqueueUpdateStreamDeliveryNonBlocking(request);
      } else {
        await enqueueUpdateStreamDelivery(request);
      }
      log.debug('[AgentStatusSubscriber] Sent status update via MessageHub: ' + outputId);
    } catch (error) {
      log.error('[AgentStatusSubscriber] Failed to send status update:', error instanceof Error ? error : new Error(String(error)));
    }
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

export interface MailboxProgressSnapshot {
  target: string;
  summaryText: string;
  counts: {
    total: number;
    unread: number;
    pending: number;
    processing: number;
  };
  recentUnread: Array<{
    id: string;
    seq: number;
    category?: string;
    priority?: number;
    shortDescription: string;
  }>;
}

function shortContent(value: unknown, maxLength = 80): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value && typeof value === 'object' && 'text' in value && typeof (value as { text: unknown }).text === 'string') {
    text = (value as { text: string }).text;
  } else if (value && typeof value === 'object' && 'summary' in value && typeof (value as { summary: unknown }).summary === 'string') {
    text = (value as { summary: string }).summary;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '(empty)';
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

/**
 * Build mailbox.status-style snapshot for progress updates.
 */
export function buildMailboxProgressSnapshot(agentId: string, fallbackAgentId = 'finger-system-agent'): MailboxProgressSnapshot | null {
  const target = (agentId || '').trim() || fallbackAgentId;
  try {
    const all = heartbeatMailbox.list(target);
    const pending = all.filter((message) => message.status === 'pending');
    const unread = pending.filter((message) => !message.readAt);
    const processing = all.filter((message) => message.status === 'processing');
    const recentUnread = unread.slice(0, 3).map((message) => ({
      id: message.id,
      seq: message.seq,
      ...(typeof message.category === 'string' ? { category: message.category } : {}),
      ...(typeof message.priority === 'number' ? { priority: message.priority } : {}),
      shortDescription: shortContent(message.content),
    }));

    const summaryText = `mailbox.status(${target}): unread=${unread.length} pending=${pending.length} processing=${processing.length}`;
    return {
      target,
      summaryText,
      counts: {
        total: all.length,
        unread: unread.length,
        pending: pending.length,
        processing: processing.length,
      },
      recentUnread,
    };
  } catch (error) {
    log.warn('[AgentStatusSubscriber] Failed to build mailbox snapshot for progress update', {
      target,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
