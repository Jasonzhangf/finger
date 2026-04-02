import type { PushSettings } from '../../bridges/types.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';
import type { SubscriberRouteState } from './agent-status-subscriber-session-utils.js';
import type { UpdateStreamSourceType } from './update-stream-policy.js';
import { buildDeliveryRouteKey, buildRouteKey, waitReasoningBufferIfNeeded } from './agent-status-subscriber-session-utils.js';
import { isNoActionableWatchdogText, isScheduledSourceType } from './agent-status-subscriber-noop.js';
import { enqueueUpdateStreamDelivery } from './update-stream-delivery-adapter.js';
import { logger } from '../../core/logger.js';
import { parseControlBlockFromReply } from '../../common/control-block.js';

const log = logger.module('AgentStatusSubscriberText');

export function normalizeBodyForDedup(text: string): string {
  return text
    .trim()
    .replace(/^正文\s*[：:]\s*/u, '')
    .replace(/^\[[^\]]+\]\s*/u, '')
    .trim();
}

export function extractLinkDigestPairs(text: string): Array<{ title: string; url: string }> {
  const regex = /\[([^\]\n]{1,220})\]\((https?:\/\/[^)\s]+)\)/gu;
  const seen = new Set<string>();
  const pairs: Array<{ title: string; url: string }> = [];
  for (const match of text.matchAll(regex)) {
    const title = (match[1] ?? '').trim();
    const url = (match[2] ?? '').trim();
    if (!title || !url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    pairs.push({ title, url });
  }
  return pairs;
}

export function normalizeLinkDigestBody(text: string): string {
  const source = text.trim();
  if (!source) return source;
  const pairs = extractLinkDigestPairs(source);
  if (pairs.length < 3) return source;
  return pairs
    .map((pair) => `[${pair.title}](${pair.url})`)
    .join('\n');
}

export function isPureLinkDigest(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const markdownLinkCount = lines.filter((line) => /^\[[^\]\n]{1,220}\]\(https?:\/\/[^)\s]+\)$/u.test(line)).length;
  const urlLineCount = lines.filter((line) => /^https?:\/\/\S+$/u.test(line)).length;
  return (
    (markdownLinkCount >= 3 && markdownLinkCount === lines.length)
    || (urlLineCount >= 3 && urlLineCount === lines.length)
  );
}

export function normalizeBodyForChannel(text: string, channelId: string): string {
  const source = text.trim();
  if (!source) return source;
  if (channelId !== 'qqbot' && channelId !== 'openclaw-weixin') {
    return source;
  }
  const pairs = extractLinkDigestPairs(source);
  if (pairs.length < 3) return source;
  return pairs
    .map((pair) => `${pair.title}\n${pair.url}`)
    .join('\n\n');
}

function stripControlBlockForChannel(text: string): string {
  const source = text.trim();
  if (!source) return source;
  const parsed = parseControlBlockFromReply(source);
  const cleaned = typeof parsed.humanResponse === 'string' ? parsed.humanResponse.trim() : '';
  return cleaned || source;
}

export function chunkBodyForChannel(text: string, channelId: string): string[] {
  if (channelId !== 'qqbot' && channelId !== 'openclaw-weixin') {
    return [text];
  }

  const blocks = text
    .split(/\n\s*\n/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (blocks.length <= 5) return [text];

  const digestLikeBlocks = blocks.filter((block) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    const urlLine = lines[lines.length - 1];
    return /^https?:\/\/\S+$/u.test(urlLine);
  });
  if (digestLikeBlocks.length < Math.max(5, Math.floor(blocks.length * 0.8))) {
    return [text];
  }

  const chunks: string[] = [];
  const chunkSize = 5;
  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize).join('\n\n'));
  }
  return chunks;
}

async function sendTextUpdate(params: {
  sessionId: string;
  agentId: string;
  text: string;
  setting: keyof Pick<PushSettings, 'reasoning' | 'bodyUpdates'>;
  label: 'reasoning' | 'body';
  prefix: string;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  resolvePushSettings: (
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ) => PushSettings;
  resolveSourceType: (
    sessionId: string,
    sourceTypeHint?: string,
  ) => UpdateStreamSourceType;
  sourceTypeHint?: string;
  messageHub?: MessageHub;
  state: SubscriberRouteState;
  reasoningBodyBufferMs: number;
}): Promise<void> {
  const mappings = params.resolveEnvelopeMappings(params.sessionId);
  if (mappings.length === 0) return;
  if (!params.messageHub) {
    log.warn(`[AgentStatusSubscriber] No messageHub available for ${params.label} update`);
    return;
  }
  const deduped = new Map<string, SessionEnvelopeMapping>();
  for (const mapping of mappings) {
    const targetKey = `${mapping.envelope.channel}::${mapping.envelope.groupId ?? ''}::${mapping.envelope.userId ?? ''}`;
    deduped.set(targetKey, mapping);
  }

  for (const mapping of deduped.values()) {
    const sourceType = params.resolveSourceType(params.sessionId, params.sourceTypeHint);
    if (
      params.label === 'body'
      && isScheduledSourceType(sourceType)
      && isNoActionableWatchdogText(params.text)
    ) {
      log.debug('[AgentStatusSubscriber] Suppress no-action watchdog body update', {
        sessionId: params.sessionId,
        agentId: params.agentId,
        sourceType,
        channel: mapping.envelope.channel,
      });
      continue;
    }
    const pushSettings = params.resolvePushSettings(params.sessionId, mapping.envelope.channel, {
      phase: params.label === 'reasoning' ? 'execution' : 'delivery',
      kind: params.label === 'reasoning' ? 'reasoning' : 'artifact',
      sourceType,
      agentId: params.agentId,
    });
    if (!pushSettings[params.setting]) continue;

    const outputId = 'channel-bridge-' + mapping.envelope.channel;
    const originalEnvelope: ChannelBridgeEnvelope = {
      id: mapping.envelope.envelopeId,
      channelId: mapping.envelope.channel,
      accountId: 'default',
      type: mapping.envelope.groupId ? 'group' : 'direct',
      senderId: mapping.envelope.userId || 'unknown',
      senderName: 'user',
      content: '',
      timestamp: Date.now(),
      metadata: {
        messageId: mapping.envelope.envelopeId,
        ...(mapping.envelope.groupId ? { groupId: mapping.envelope.groupId } : {}),
      },
    };

    if (params.label === 'body') {
      await waitReasoningBufferIfNeeded({
        sessionId: params.sessionId,
        mapping,
        reasoningBodyBufferMs: params.reasoningBodyBufferMs,
        state: params.state,
      });
    }

    const payloadText = params.label === 'body'
      ? normalizeBodyForChannel(params.text, mapping.envelope.channel)
      : params.text;
    const chunks = params.label === 'body'
      ? chunkBodyForChannel(payloadText, mapping.envelope.channel)
      : [payloadText];

    for (let i = 0; i < chunks.length; i += 1) {
      const content = `${params.prefix}${chunks[i]}`;
      const message = {
        channelId: mapping.envelope.channel,
        target: mapping.envelope.groupId ? `group:${mapping.envelope.groupId}` : (mapping.envelope.userId || 'unknown'),
        content,
        originalEnvelope,
        [params.label]: {
          sessionId: params.sessionId,
          agentId: params.agentId,
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
        },
      };
      const deliveryRouteKey = buildDeliveryRouteKey(
        mapping.envelope.channel,
        mapping.envelope.userId,
        mapping.envelope.groupId,
      );
      await enqueueUpdateStreamDelivery({
        routeKey: deliveryRouteKey,
        dedupSignature: `${params.sessionId}|${params.agentId}|${params.label}|${content}`,
        send: async () => {
          await params.messageHub!.routeToOutput(outputId, message);
        },
        meta: {
          channelId: mapping.envelope.channel,
          sessionId: params.sessionId,
          agentId: params.agentId,
          updateType: params.label,
          chunkIndex: i + 1,
          chunkTotal: chunks.length,
        },
      });
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
    if (params.label === 'reasoning') {
      params.state.lastReasoningPushAtByRoute.set(buildRouteKey(params.sessionId, mapping), Date.now());
    }
  }
}

export async function sendReasoningUpdate(params: {
  sessionId: string;
  agentId: string;
  reasoningText: string;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  resolvePushSettings: (
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ) => PushSettings;
  resolveSourceType: (
    sessionId: string,
    sourceTypeHint?: string,
  ) => UpdateStreamSourceType;
  messageHub?: MessageHub;
  state: SubscriberRouteState;
  reasoningBodyBufferMs: number;
}): Promise<void> {
  const text = params.reasoningText.trim();
  if (!text) return;
  await sendTextUpdate({
    ...params,
    text,
    setting: 'reasoning',
    label: 'reasoning',
    prefix: '思考：',
  });
}

export async function sendBodyUpdate(params: {
  sessionId: string;
  agentId: string;
  bodyText: string;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  resolvePushSettings: (
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ) => PushSettings;
  resolveSourceType: (
    sessionId: string,
    sourceTypeHint?: string,
  ) => UpdateStreamSourceType;
  messageHub?: MessageHub;
  state: SubscriberRouteState;
  reasoningBodyBufferMs: number;
  finalReplyBySession: Map<string, { normalized: string; at: number }>;
  lastBodySentBySession: Map<string, { normalized: string; at: number }>;
  lastBodySentByRoute: Map<string, { normalized: string; at: number }>;
}): Promise<void> {
  const text = normalizeLinkDigestBody(stripControlBlockForChannel(params.bodyText)).trim();
  if (!text) return;
  const pureLinkDigest = isPureLinkDigest(text);
  const normalizedBody = normalizeBodyForDedup(text);

  const finalReply = params.finalReplyBySession.get(params.sessionId);
  if (finalReply) {
    const ageMs = Date.now() - finalReply.at;
    if (ageMs <= 10_000 && finalReply.normalized === normalizedBody) {
      params.finalReplyBySession.delete(params.sessionId);
      return;
    }
    if (ageMs > 10_000) {
      params.finalReplyBySession.delete(params.sessionId);
    }
  }

  const dedupKey = `${params.sessionId}:${normalizedBody.slice(0, 200)}`;
  if ((sendBodyUpdate as unknown as { _lastBodyDedupKey?: string })._lastBodyDedupKey === dedupKey) {
    return;
  }
  (sendBodyUpdate as unknown as { _lastBodyDedupKey?: string })._lastBodyDedupKey = dedupKey;

  const sentAt = Date.now();
  params.lastBodySentBySession.set(params.sessionId, {
    normalized: normalizedBody,
    at: sentAt,
  });
  const preMappings = params.resolveEnvelopeMappings(params.sessionId);
  for (const mapping of preMappings) {
    const routeKey = buildDeliveryRouteKey(
      mapping.envelope.channel,
      mapping.envelope.userId,
      mapping.envelope.groupId,
    );
    params.lastBodySentByRoute.set(routeKey, {
      normalized: normalizedBody,
      at: sentAt,
    });
  }

  await sendTextUpdate({
    sessionId: params.sessionId,
    agentId: params.agentId,
    text,
    setting: 'bodyUpdates',
    label: 'body',
    prefix: pureLinkDigest ? '' : '正文：',
    resolveEnvelopeMappings: params.resolveEnvelopeMappings,
    resolvePushSettings: params.resolvePushSettings,
    resolveSourceType: params.resolveSourceType,
    messageHub: params.messageHub,
    state: params.state,
    reasoningBodyBufferMs: params.reasoningBodyBufferMs,
  });
}
