import type { PushSettings } from '../../bridges/types.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';

export interface SessionRelationInfo {
  sessionId: string;
  relation: 'standalone' | 'root' | 'child';
  ownerAgentId?: string;
  parentSessionId?: string;
  rootSessionId?: string;
}

export interface SubscriberRouteState {
  sessionEnvelopeMap: Map<string, SessionEnvelopeMapping>;
  sessionObserverMap: Map<string, SessionEnvelopeMapping['envelope'][]>;
  lastProgressMailboxSummaryBySession: Map<string, string>;
  lastReasoningPushAtByRoute: Map<string, number>;
}

export function buildRouteKey(sessionId: string, mapping: SessionEnvelopeMapping): string {
  const envelope = mapping.envelope;
  return [
    sessionId,
    envelope.channel,
    envelope.envelopeId,
    envelope.userId ?? '',
    envelope.groupId ?? '',
  ].join(':');
}

export function buildDeliveryRouteKey(channelId: string, userId?: string, groupId?: string): string {
  return [channelId.trim(), (groupId ?? '').trim(), (userId ?? '').trim()].join('::');
}

function normalizeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 18) return trimmed;
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

export function resolveSessionRelationInfo(
  deps: AgentRuntimeDeps,
  sessionId: string,
): SessionRelationInfo {
  const session = deps.sessionManager.getSession(sessionId);
  const context = (session?.context && typeof session.context === 'object')
    ? (session.context as Record<string, unknown>)
    : {};
  const parentSessionId = normalizeSessionId(context.parentSessionId);
  const rootSessionId = normalizeSessionId(context.rootSessionId);
  const ownerAgentId = normalizeSessionId(context.ownerAgentId);
  const hasParentLike = Boolean(parentSessionId) || (Boolean(rootSessionId) && rootSessionId !== sessionId);

  if (hasParentLike) {
    return {
      sessionId,
      relation: 'child',
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
    };
  }

  const isRootLike = typeof context.sessionTier === 'string'
    && context.sessionTier.toLowerCase().includes('root');
  if (isRootLike) {
    return {
      sessionId,
      relation: 'root',
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(rootSessionId ? { rootSessionId } : {}),
    };
  }

  return {
    sessionId,
    relation: 'standalone',
    ...(ownerAgentId ? { ownerAgentId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
  };
}

export function buildSessionRelationLine(info: SessionRelationInfo): string | undefined {
  if (info.relation !== 'child') return undefined;
  const parent = info.parentSessionId || info.rootSessionId;
  const parts = [
    `子会话 ${shortSessionId(info.sessionId)}`,
    parent ? `父会话 ${shortSessionId(parent)}` : '',
    info.ownerAgentId ? `Agent ${info.ownerAgentId}` : '',
  ].filter((item) => item.length > 0);
  if (parts.length === 0) return undefined;
  return `关系: ${parts.join(' · ')}`;
}

export async function waitReasoningBufferIfNeeded(params: {
  sessionId: string;
  mapping: SessionEnvelopeMapping;
  reasoningBodyBufferMs: number;
  state: SubscriberRouteState;
}): Promise<void> {
  if (params.reasoningBodyBufferMs <= 0) return;
  if (params.mapping.envelope.channel !== 'qqbot') return;

  const routeKey = buildRouteKey(params.sessionId, params.mapping);
  const lastReasoningAt = params.state.lastReasoningPushAtByRoute.get(routeKey);
  if (!lastReasoningAt) return;

  const elapsed = Date.now() - lastReasoningAt;
  const waitMs = params.reasoningBodyBufferMs - elapsed;
  if (waitMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export function cleanupRouteStateBySession(sessionId: string, state: SubscriberRouteState): void {
  const prefix = `${sessionId}:`;
  for (const key of state.lastReasoningPushAtByRoute.keys()) {
    if (key.startsWith(prefix)) {
      state.lastReasoningPushAtByRoute.delete(key);
    }
  }
}

export function resolveContextWithFallback(sessionId: string, deps: AgentRuntimeDeps): Record<string, unknown> {
  const visited = new Set<string>();
  let currentSessionId = sessionId;
  while (currentSessionId && !visited.has(currentSessionId)) {
    visited.add(currentSessionId);
    const session = deps.sessionManager.getSession(currentSessionId);
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const hasInteractive = context.progressDelivery !== undefined || context.progress_delivery !== undefined;
    const hasScheduled = context.scheduledProgressDelivery !== undefined || context.scheduled_progress_delivery !== undefined;
    if (hasInteractive || hasScheduled) {
      return context;
    }
    const nextSessionId = typeof context.rootSessionId === 'string' && context.rootSessionId.trim().length > 0
      ? context.rootSessionId.trim()
      : typeof context.parentSessionId === 'string' && context.parentSessionId.trim().length > 0
        ? context.parentSessionId.trim()
        : '';
    if (!nextSessionId) break;
    currentSessionId = nextSessionId;
  }
  const session = deps.sessionManager.getSession(sessionId);
  return (session?.context && typeof session.context === 'object')
    ? (session.context as Record<string, unknown>)
    : {};
}

export function resolvePushSettingsForSession(params: {
  sessionId: string;
  channelId: string;
  deps: AgentRuntimeDeps;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  fallbackPushSettings: PushSettings;
  normalizePolicy: (value: unknown) => ProgressDeliveryPolicy | undefined;
  applyPolicy: (base: PushSettings, policy?: ProgressDeliveryPolicy) => PushSettings;
}): PushSettings {
  const base = params.channelBridgeManager
    ? params.channelBridgeManager.getPushSettings(params.channelId)
    : params.fallbackPushSettings;
  const context = resolveContextWithFallback(params.sessionId, params.deps);
  const policy = params.normalizePolicy(
    context.progressDelivery
    ?? context.progress_delivery
    ?? context.scheduledProgressDelivery
    ?? context.scheduled_progress_delivery,
  );
  return params.applyPolicy(base, policy);
}

export function registerSessionMapping(
  sessionId: string,
  envelope: SessionEnvelopeMapping['envelope'],
  state: SubscriberRouteState,
): void {
  const existing = state.sessionEnvelopeMap.get(sessionId);
  if (!existing) {
    state.sessionEnvelopeMap.set(sessionId, {
      sessionId,
      envelope,
      timestamp: Date.now(),
    });
    return;
  }

  existing.timestamp = Date.now();
  if (sameEnvelope(existing.envelope, envelope)) {
    return;
  }
  if (sameDeliveryRoute(existing.envelope, envelope)) {
    existing.envelope = envelope;
    return;
  }

  const observers = state.sessionObserverMap.get(sessionId) ?? [];
  const sameRouteIndex = observers.findIndex((item) => sameDeliveryRoute(item, envelope));
  if (sameRouteIndex >= 0) {
    observers[sameRouteIndex] = envelope;
    state.sessionObserverMap.set(sessionId, observers);
    return;
  }
  if (!observers.some((item) => sameEnvelope(item, envelope))) {
    observers.push(envelope);
    state.sessionObserverMap.set(sessionId, observers);
  }
}

export function clearSessionObservers(sessionId: string, state: SubscriberRouteState): void {
  state.sessionEnvelopeMap.delete(sessionId);
  state.sessionObserverMap.delete(sessionId);
  state.lastProgressMailboxSummaryBySession.delete(sessionId);
  cleanupRouteStateBySession(sessionId, state);
}

export function resolveEnvelopeMappingForSession(
  sessionId: string,
  deps: AgentRuntimeDeps,
  state: SubscriberRouteState,
): SessionEnvelopeMapping | null {
  const direct = state.sessionEnvelopeMap.get(sessionId);
  if (direct) return direct;

  if (sessionId === 'default' || sessionId === 'system-default-session') {
    const currentSession = deps.sessionManager.getCurrentSession?.();
    if (currentSession?.id) {
      const currentMapping = state.sessionEnvelopeMap.get(currentSession.id);
      if (currentMapping) {
        return {
          sessionId,
          envelope: currentMapping.envelope,
          timestamp: Date.now(),
        };
      }
    }

    const getSystemSession = (deps.sessionManager as any).getOrCreateSystemSession;
    if (typeof getSystemSession === 'function') {
      const systemSession = getSystemSession.call(deps.sessionManager);
      const systemMapping = systemSession ? state.sessionEnvelopeMap.get(systemSession.id) : null;
      if (systemMapping) {
        return {
          sessionId,
          envelope: systemMapping.envelope,
          timestamp: Date.now(),
        };
      }
    }
  }

  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return null;

  const sessionContext = (session.context && typeof session.context === 'object')
    ? (session.context as Record<string, unknown>)
    : {};
  const contextChannelId = typeof sessionContext.channelId === 'string'
    ? sessionContext.channelId.trim()
    : '';
  const contextUserId = typeof sessionContext.channelUserId === 'string'
    ? sessionContext.channelUserId.trim()
    : '';
  const contextGroupId = typeof sessionContext.channelGroupId === 'string'
    ? sessionContext.channelGroupId.trim()
    : undefined;
  const contextMessageId = typeof sessionContext.lastChannelMessageId === 'string'
    ? sessionContext.lastChannelMessageId.trim()
    : '';

  if (contextChannelId && contextUserId) {
    const recovered: SessionEnvelopeMapping = {
      sessionId,
      envelope: {
        channel: contextChannelId,
        envelopeId: contextMessageId,
        userId: contextUserId,
        ...(contextGroupId ? { groupId: contextGroupId } : {}),
      },
      timestamp: Date.now(),
    };
    state.sessionEnvelopeMap.set(sessionId, recovered);
    return recovered;
  }

  const parentSessionId = typeof sessionContext.parentSessionId === 'string' ? sessionContext.parentSessionId : '';
  const rootSessionId = typeof sessionContext.rootSessionId === 'string' ? sessionContext.rootSessionId : '';
  const fallbackId = rootSessionId || parentSessionId;
  if (!fallbackId) return null;

  const fallback = state.sessionEnvelopeMap.get(fallbackId);
  if (!fallback) return null;

  const mapped: SessionEnvelopeMapping = {
    sessionId,
    envelope: fallback.envelope,
    timestamp: Date.now(),
  };
  state.sessionEnvelopeMap.set(sessionId, mapped);
  return mapped;
}

export function resolveEnvelopeMappingsForSession(
  sessionId: string,
  deps: AgentRuntimeDeps,
  state: SubscriberRouteState,
): SessionEnvelopeMapping[] {
  const primary = resolveEnvelopeMappingForSession(sessionId, deps, state);
  if (!primary) return [];

  const observers = state.sessionObserverMap.get(sessionId) ?? [];
  if (observers.length === 0) return [primary];

  const mappings: SessionEnvelopeMapping[] = [primary];
  for (const envelope of observers) {
    mappings.push({
      sessionId,
      envelope,
      timestamp: primary.timestamp,
    });
  }
  return mappings;
}

export function sameEnvelope(
  left: SessionEnvelopeMapping['envelope'],
  right: SessionEnvelopeMapping['envelope'],
): boolean {
  return left.channel === right.channel
    && left.envelopeId === right.envelopeId
    && left.userId === right.userId
    && left.groupId === right.groupId;
}

export function sameDeliveryRoute(
  left: SessionEnvelopeMapping['envelope'],
  right: SessionEnvelopeMapping['envelope'],
): boolean {
  return left.channel === right.channel
    && left.userId === right.userId
    && left.groupId === right.groupId;
}

export async function finalizeChannelTurnDelivery(params: {
  sessionId: string;
  finalReply?: string;
  agentId?: string;
  finishReason?: string;
  deps: AgentRuntimeDeps;
  state: SubscriberRouteState;
  messageHub?: MessageHub;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
}): Promise<void> {
  const primary = params.resolveEnvelopeMapping(params.sessionId);
  if (!primary) return;

  const observers = params.state.sessionObserverMap.get(params.sessionId) ?? [];
  const allEnvelopes = [primary.envelope, ...observers];
  const dedupedEnvelopes = new Map<string, SessionEnvelopeMapping['envelope']>();
  for (const envelope of allEnvelopes) {
    const key = `${envelope.channel}::${envelope.groupId ?? ''}::${envelope.userId ?? ''}`;
    dedupedEnvelopes.set(key, envelope);
  }

  const deliverText = async (envelopes: SessionEnvelopeMapping['envelope'][], content: string): Promise<void> => {
    if (!params.messageHub || !content.trim()) return;
    for (const envelope of envelopes) {
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
      await params.messageHub.routeToOutput(outputId, {
        channelId: envelope.channel,
        target: envelope.groupId ? `group:${envelope.groupId}` : (envelope.userId || 'unknown'),
        content,
        originalEnvelope,
      });
    }
  };

  if (params.finalReply && params.finalReply.trim().length > 0 && observers.length > 0 && params.messageHub) {
    const timestamp = new Date();
    const year = timestamp.getFullYear();
    const month = String(timestamp.getMonth() + 1).padStart(2, '0');
    const day = String(timestamp.getDate()).padStart(2, '0');
    const hours = String(timestamp.getHours()).padStart(2, '0');
    const minutes = String(timestamp.getMinutes()).padStart(2, '0');
    const seconds = String(timestamp.getSeconds()).padStart(2, '0');
    const ms = String(timestamp.getMilliseconds()).padStart(3, '0');
    const offset = -timestamp.getTimezoneOffset();
    const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
    const offsetSign = offset >= 0 ? '+' : '-';
    const formattedTimestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetSign}${offsetHours}:${offsetMinutes}`;
    const agentName = params.agentId?.replace(/^finger-/, '').replace(/-/g, ' ') || 'system agent';
    const content = `[${agentName}] [${formattedTimestamp}] ${params.finalReply.trim()}`;
    await deliverText(observers, content);
  }

  if (params.finishReason === 'stop') {
    const noticeTargets = Array.from(dedupedEnvelopes.values())
      .filter((envelope) => envelope.channel === 'qqbot' || envelope.channel === 'openclaw-weixin');
    if (noticeTargets.length > 0) {
      await deliverText(noticeTargets, '本轮推理已结束。');
    }
  }

  clearSessionObservers(params.sessionId, params.state);
}
