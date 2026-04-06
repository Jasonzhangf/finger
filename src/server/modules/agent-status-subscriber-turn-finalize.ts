import type { PushSettings } from '../../bridges/types.js';
import type { ChannelBridgeManager } from '../../bridges/manager.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';
import type { SubscriberRouteState } from './agent-status-subscriber-session-utils.js';
import type { UpdateStreamSourceType } from './update-stream-policy.js';
import { enqueueUpdateStreamDelivery } from './update-stream-delivery-adapter.js';
import { isNoActionableWatchdogText, isScheduledSourceType } from './agent-status-subscriber-noop.js';
import { parseControlBlockFromReply, stripControlLikeJsonPayload } from '../../common/control-block.js';
import {
  inferUpdateStreamSourceType,
  resolveUpdateStreamPolicy,
} from './update-stream-policy.js';
import { applyProjectStatusGatewayPatch } from './project-status-gateway.js';
import { routeToOutputWithRecovery } from './channel-delivery-recovery.js';
import { inferSessionUpdateSourceType } from './agent-status-subscriber-session-utils.js';

export async function finalizeChannelTurnDelivery(params: {
  sessionId: string;
  finalReply?: string;
  agentId?: string;
  finishReason?: string;
  deps: AgentRuntimeDeps;
  state: SubscriberRouteState;
  messageHub?: MessageHub;
  channelBridgeManager?: ChannelBridgeManager;
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
      const nextRevision = typeof currentProjectTaskState.revision === 'number'
        ? currentProjectTaskState.revision + 1
        : undefined;
      applyProjectStatusGatewayPatch({
        sessionManager: params.deps.sessionManager,
        sessionIds: [params.sessionId],
        source: 'agent-status-subscriber.finalizeSessionOutput.no_actionable_watchdog',
        patch: {
          active: false,
          status: 'closed',
          ...(typeof nextRevision === 'number' ? { revision: nextRevision } : {}),
          note: 'watchdog_no_actionable_auto_closed',
          summary: typeof params.finalReply === 'string' ? params.finalReply.slice(0, 240) : 'watchdog_no_actionable',
          taskId: currentProjectTaskState.taskId,
          taskName: currentProjectTaskState.taskName,
          dispatchId: currentProjectTaskState.dispatchId,
          boundSessionId: currentProjectTaskState.boundSessionId,
          sourceAgentId: currentProjectTaskState.sourceAgentId,
          targetAgentId: currentProjectTaskState.targetAgentId,
        },
      });
    }
    return;
  }

  const policy = resolveUpdateStreamPolicy({ sourceType, phase: 'final_reply', kind: 'final' });
  const finalReply = typeof params.finalReply === 'string' ? params.finalReply.trim() : '';
  const parsed = parseControlBlockFromReply(finalReply);
  const humanResponse = parsed.humanResponse.trim();
  const stripped = stripControlLikeJsonPayload(humanResponse).trim();
  const replyToSend = stripped.length > 0 ? stripped : humanResponse;

  if (replyToSend.length === 0) return;

  for (const envelope of dedupedEnvelopes.values()) {
    const pushSettings = typeof params.resolvePushSettings === 'function'
      ? params.resolvePushSettings(params.sessionId, envelope.channel, { phase: 'final_reply', kind: 'final', sourceType, agentId: params.agentId })
      : undefined;
    const deliveryText = replyToSend;
    const routeKey = `${envelope.channel}::${envelope.groupId ?? ''}::${envelope.userId ?? ''}`;

    enqueueUpdateStreamDelivery({
      sessionId: params.sessionId,
      envelope,
      policy,
      pushSettings,
      text: deliveryText,
      sourceType,
      phase: 'final_reply',
      kind: 'final',
      deps: params.deps,
      messageHub: params.messageHub,
      channelBridgeManager: params.channelBridgeManager,
      dedupSignature: `${params.sessionId}|${params.agentId ?? 'unknown'}|final|${routeKey}|${deliveryText.slice(0, 100)}`,
    });
  }
}

function parseProjectTaskState(value: unknown): {
  active: boolean;
  status: string;
  taskId?: string;
  taskName?: string;
  dispatchId?: string;
  boundSessionId?: string;
  sourceAgentId?: string;
  targetAgentId?: string;
  revision?: number;
  note?: string;
  summary?: string;
  updatedAt?: string;
} | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  return {
    active: typeof obj.active === 'boolean' ? obj.active : false,
    status: typeof obj.status === 'string' ? obj.status : 'unknown',
    taskId: typeof obj.taskId === 'string' ? obj.taskId : undefined,
    taskName: typeof obj.taskName === 'string' ? obj.taskName : undefined,
    dispatchId: typeof obj.dispatchId === 'string' ? obj.dispatchId : undefined,
    boundSessionId: typeof obj.boundSessionId === 'string' ? obj.boundSessionId : undefined,
    sourceAgentId: typeof obj.sourceAgentId === 'string' ? obj.sourceAgentId : undefined,
    targetAgentId: typeof obj.targetAgentId === 'string' ? obj.targetAgentId : undefined,
    revision: typeof obj.revision === 'number' ? obj.revision : undefined,
    note: typeof obj.note === 'string' ? obj.note : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
  };
}
