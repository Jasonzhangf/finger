import type { PushSettings } from '../../bridges/types.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { enqueueUpdateStreamDelivery } from './update-stream-delivery-adapter.js';
import { isNoActionableWatchdogText, isScheduledSourceType } from './agent-status-subscriber-noop.js';
import {
  inferUpdateStreamRole,
  inferUpdateStreamSourceType,
  type UpdateStreamSourceType,
  resolveUpdateStreamPolicy,
} from './update-stream-policy.js';
import {
  resolveEnvelopeMappingForSession,
  resolveEnvelopeMappingsForSession,
  sameDeliveryRoute,
  sameEnvelope,
} from './agent-status-subscriber-mapping-utils.js';
import {
  parseProjectTaskState,
  mergeProjectTaskState,
} from '../../common/project-task-state.js';

export {
  resolveEnvelopeMappingForSession,
  resolveEnvelopeMappingsForSession,
} from './agent-status-subscriber-mapping-utils.js';

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
  if (parent && parent === info.sessionId) return undefined;
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
  phase?: string;
  kind?: string;
  sourceType?: string;
  agentId?: string;
}): PushSettings {
  const base = params.channelBridgeManager
    ? params.channelBridgeManager.getPushSettings(params.channelId)
    : params.fallbackPushSettings;
  const context = resolveContextWithFallback(params.sessionId, params.deps);
  const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
  const candidateAgentId = typeof params.agentId === 'string' && params.agentId.trim().length > 0
    ? params.agentId.trim()
    : ownerAgentId;
  const sourceType = inferSessionUpdateSourceType({
    sessionId: params.sessionId,
    deps: params.deps,
    sourceTypeHint: params.sourceType,
  });
  const role = inferUpdateStreamRole(candidateAgentId);
  const updateStreamPolicy = resolveUpdateStreamPolicy({
    channelId: params.channelId,
    role,
    sourceType,
    phase: params.phase,
    kind: params.kind,
  });
  const mergedBase = params.applyPolicy(base, updateStreamPolicy);

  const sessionPolicy = params.normalizePolicy(
    context.progressDelivery
    ?? context.progress_delivery
    ?? context.scheduledProgressDelivery
    ?? context.scheduled_progress_delivery,
  );
  return params.applyPolicy(mergedBase, sessionPolicy);
}

export function inferSessionUpdateSourceType(params: {
  sessionId: string;
  deps: AgentRuntimeDeps;
  sourceTypeHint?: string;
}): UpdateStreamSourceType {
  const context = resolveContextWithFallback(params.sessionId, params.deps);
  const hasScheduledPolicy = context.scheduledProgressDelivery !== undefined || context.scheduled_progress_delivery !== undefined;
  const explicitRaw = typeof params.sourceTypeHint === 'string' && params.sourceTypeHint.trim().length > 0
    ? params.sourceTypeHint
    : typeof context.sourceType === 'string' && context.sourceType.trim().length > 0
      ? context.sourceType
      : typeof context.source_type === 'string' && context.source_type.trim().length > 0
        ? context.source_type
        : typeof context.source === 'string' && context.source.trim().length > 0
          ? context.source
          : undefined;
  const explicit = normalizeSourceTypeAlias(explicitRaw);
  return inferUpdateStreamSourceType({
    explicit,
    hasScheduledPolicy,
  });
}

function normalizeSourceTypeAlias(raw: unknown): UpdateStreamSourceType | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'user') return 'user';
  if (normalized === 'heartbeat' || normalized === 'system-heartbeat' || normalized.includes('heartbeat')) {
    return 'heartbeat';
  }
  if (normalized === 'mailbox' || normalized === 'mailbox-check' || normalized.includes('mailbox')) {
    return 'mailbox';
  }
  if (normalized === 'cron' || normalized === 'clock' || normalized.endsWith('-cron') || normalized.includes('schedule')) {
    return 'cron';
  }
  if (normalized === 'system-inject' || normalized === 'system_direct_inject' || normalized.includes('inject')) {
    return 'system-inject';
  }
  return undefined;
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

export async function finalizeChannelTurnDelivery(params: {
  sessionId: string;
  finalReply?: string;
  agentId?: string;
  finishReason?: string;
  deps: AgentRuntimeDeps;
  state: SubscriberRouteState;
  messageHub?: MessageHub;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
  resolvePushSettings?: (
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ) => PushSettings;
  resolveSourceType?: (
    sessionId: string,
    sourceTypeHint?: string,
  ) => UpdateStreamSourceType;
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

  const sourceType = typeof params.resolveSourceType === 'function'
    ? params.resolveSourceType(params.sessionId)
    : inferSessionUpdateSourceType({
      sessionId: params.sessionId,
      deps: params.deps,
    });
  const normalizedAgentId = typeof params.agentId === 'string' ? params.agentId.trim().toLowerCase() : '';
  const isSystemLikeAgent = normalizedAgentId.includes('system-agent') || normalizedAgentId === 'finger-system-agent';
  const noopWatchdogReply = isNoActionableWatchdogText(params.finalReply);
  const suppressNoopDelivery = noopWatchdogReply
    && (isScheduledSourceType(sourceType) || isSystemLikeAgent);
  if (suppressNoopDelivery) {
    const session = params.deps.sessionManager.getSession(params.sessionId);
    const currentProjectTaskState = parseProjectTaskState(session?.context?.projectTaskState);
    const targetAgentId = typeof params.agentId === 'string' ? params.agentId.trim() : '';
    const finishReason = typeof params.finishReason === 'string' ? params.finishReason.trim().toLowerCase() : '';
    const stateUpdatedAtMs = currentProjectTaskState ? Date.parse(currentProjectTaskState.updatedAt) : Number.NaN;
    const stateAgeMs = Number.isFinite(stateUpdatedAtMs) ? Date.now() - stateUpdatedAtMs : Number.POSITIVE_INFINITY;
    const currentNote = typeof currentProjectTaskState?.note === 'string'
      ? currentProjectTaskState.note.trim().toLowerCase()
      : '';
    const allowAutoClose = finishReason === 'stop'
      && (
        currentNote.startsWith('dispatch_suppressed_')
        || stateAgeMs >= 15 * 60 * 1000
      );
    if (
      currentProjectTaskState
      && currentProjectTaskState.active
      && (!targetAgentId || currentProjectTaskState.targetAgentId === targetAgentId)
      && allowAutoClose
    ) {
      params.deps.sessionManager.updateContext(params.sessionId, {
        projectTaskState: mergeProjectTaskState(currentProjectTaskState, {
          active: false,
          status: 'closed',
          note: 'watchdog_no_actionable_auto_closed',
          summary: typeof params.finalReply === 'string' ? params.finalReply.slice(0, 240) : 'watchdog_no_actionable',
        }),
      });
    }
    clearSessionObservers(params.sessionId, params.state);
    return;
  }

  const deliverText = async (
    envelopes: SessionEnvelopeMapping['envelope'][],
    content: string,
    setting: keyof Pick<PushSettings, 'bodyUpdates' | 'statusUpdate'>,
  ): Promise<void> => {
    if (!params.messageHub || !content.trim()) return;
    for (const envelope of envelopes) {
      if (params.resolvePushSettings) {
        const pushSettings = params.resolvePushSettings(params.sessionId, envelope.channel, {
          phase: setting === 'bodyUpdates' ? 'delivery' : 'completion',
          kind: setting === 'bodyUpdates' ? 'artifact' : 'status',
          agentId: params.agentId,
        });
        if (!pushSettings[setting]) continue;
      }
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
      const routeKey = buildDeliveryRouteKey(
        envelope.channel,
        envelope.userId,
        envelope.groupId,
      );
      await enqueueUpdateStreamDelivery({
        routeKey,
        dedupSignature: `${params.sessionId}|${params.agentId ?? 'unknown'}|finalize|${setting}|${content}`,
        send: async () => {
          await params.messageHub!.routeToOutput(outputId, {
            channelId: envelope.channel,
            target: envelope.groupId ? `group:${envelope.groupId}` : (envelope.userId || 'unknown'),
            content,
            originalEnvelope,
          });
        },
        meta: {
          channelId: envelope.channel,
          sessionId: params.sessionId,
          agentId: params.agentId ?? 'unknown',
          updateType: setting === 'bodyUpdates' ? 'finalize-body' : 'finalize-status',
        },
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
    await deliverText(observers, content, 'bodyUpdates');
  }

  const shouldEmitStopNotice = params.finishReason === 'stop'
    && !isScheduledSourceType(sourceType)
    && !noopWatchdogReply;
  if (shouldEmitStopNotice) {
    const noticeTargets = Array.from(dedupedEnvelopes.values())
      .filter((envelope) => envelope.channel === 'qqbot' || envelope.channel === 'openclaw-weixin');
    if (noticeTargets.length > 0) {
      const finalReplyPreview = typeof params.finalReply === 'string'
        ? params.finalReply.trim().replace(/\s+/g, ' ').slice(0, 140)
        : '';
      const stopNotice = finalReplyPreview.length > 0
        ? `本轮推理已结束：${finalReplyPreview}`
        : '本轮推理已结束。';
      await deliverText(noticeTargets, stopNotice, 'statusUpdate');
    }
  }

  clearSessionObservers(params.sessionId, params.state);
}
