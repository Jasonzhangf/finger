import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { SessionEnvelopeMapping } from './agent-status-subscriber-types.js';
import type { SubscriberRouteState } from './agent-status-subscriber-session-utils.js';

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

export function resolveEnvelopeMappingForSession(
  sessionId: string,
  deps: AgentRuntimeDeps,
  state: SubscriberRouteState,
  visited?: Set<string>,
): SessionEnvelopeMapping | null {
  const cycleGuard = visited ?? new Set<string>();
  if (cycleGuard.has(sessionId)) return null;
  cycleGuard.add(sessionId);

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
  const statusRouteSessionId = typeof sessionContext.statusRouteSessionId === 'string'
    ? sessionContext.statusRouteSessionId
    : '';
  const candidates = [parentSessionId, statusRouteSessionId, rootSessionId]
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && value !== sessionId && all.indexOf(value) === index);
  if (candidates.length === 0) return null;

  for (const fallbackId of candidates) {
    const fallback = state.sessionEnvelopeMap.get(fallbackId)
      ?? resolveEnvelopeMappingForSession(fallbackId, deps, state, cycleGuard);
    if (!fallback) continue;
    const mapped: SessionEnvelopeMapping = {
      sessionId,
      envelope: fallback.envelope,
      timestamp: Date.now(),
    };
    state.sessionEnvelopeMap.set(sessionId, mapped);
    return mapped;
  }

  return null;
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

