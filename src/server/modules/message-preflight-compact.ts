import { getCompressTokenThreshold, getContextWindow } from '../../core/user-settings.js';
import { logger } from '../../core/logger.js';
import type { Session } from '../../orchestration/session-types.js';
import { estimateTokens } from '../../utils/token-counter.js';
import { isObjectRecord } from '../common/object.js';
import { extractMessageTextForSession } from './message-session.js';

const log = logger.module('message-preflight-compact');

export interface PreflightCompactDecision {
  requestMessage: unknown;
  applied: boolean;
  sessionTokens: number;
  incomingTokens: number;
  projectedTokens: number;
  thresholdTokens: number;
  contextWindowTokens: number;
  reason:
    | 'session_missing'
    | 'request_empty'
    | 'already_requested'
    | 'explicitly_disabled'
    | 'below_threshold'
    | 'preflight_manual_compact';
}

function estimateSessionProjectionTokens(session: Session): number {
  const persistedTotal = typeof session.totalTokens === 'number' && Number.isFinite(session.totalTokens)
    ? Math.max(0, Math.floor(session.totalTokens))
    : 0;
  const snapshotMessages = Array.isArray(session.messages) ? session.messages : [];
  const snapshotTotal = snapshotMessages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0);
  return Math.max(persistedTotal, snapshotTotal);
}

function injectCompactMetadata(
  requestMessage: unknown,
  metadataPatch: Record<string, unknown>,
): unknown {
  if (typeof requestMessage === 'string') {
    return {
      text: requestMessage,
      metadata: metadataPatch,
    };
  }

  if (!isObjectRecord(requestMessage)) {
    return requestMessage;
  }

  const existingMetadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
  return {
    ...requestMessage,
    metadata: {
      ...existingMetadata,
      ...metadataPatch,
    },
  };
}

export function applyPreflightCompactToRequest(params: {
  session: Session | null | undefined;
  requestMessage: unknown;
  targetAgentId: string;
}): PreflightCompactDecision {
  const { session, requestMessage, targetAgentId } = params;
  if (!session) {
    return {
      requestMessage,
      applied: false,
      sessionTokens: 0,
      incomingTokens: 0,
      projectedTokens: 0,
      thresholdTokens: getCompressTokenThreshold(),
      contextWindowTokens: getContextWindow(),
      reason: 'session_missing',
    };
  }

  const incomingText = extractMessageTextForSession(requestMessage)?.trim() ?? '';
  if (!incomingText) {
    return {
      requestMessage,
      applied: false,
      sessionTokens: estimateSessionProjectionTokens(session),
      incomingTokens: 0,
      projectedTokens: estimateSessionProjectionTokens(session),
      thresholdTokens: getCompressTokenThreshold(),
      contextWindowTokens: getContextWindow(),
      reason: 'request_empty',
    };
  }

  const existingMetadata = isObjectRecord(requestMessage) && isObjectRecord(requestMessage.metadata)
    ? requestMessage.metadata
    : {};
  if (existingMetadata.compactManual === true) {
    return {
      requestMessage,
      applied: false,
      sessionTokens: estimateSessionProjectionTokens(session),
      incomingTokens: estimateTokens(incomingText),
      projectedTokens: estimateSessionProjectionTokens(session) + estimateTokens(incomingText),
      thresholdTokens: getCompressTokenThreshold(),
      contextWindowTokens: getContextWindow(),
      reason: 'already_requested',
    };
  }
  if (existingMetadata.compactManual === false || existingMetadata.preflightCompactDisabled === true) {
    return {
      requestMessage,
      applied: false,
      sessionTokens: estimateSessionProjectionTokens(session),
      incomingTokens: estimateTokens(incomingText),
      projectedTokens: estimateSessionProjectionTokens(session) + estimateTokens(incomingText),
      thresholdTokens: getCompressTokenThreshold(),
      contextWindowTokens: getContextWindow(),
      reason: 'explicitly_disabled',
    };
  }

  const sessionTokens = estimateSessionProjectionTokens(session);
  const incomingTokens = estimateTokens(incomingText);
  const projectedTokens = sessionTokens + incomingTokens;
  const thresholdTokens = getCompressTokenThreshold();
  const contextWindowTokens = getContextWindow();

  if (projectedTokens < thresholdTokens) {
    return {
      requestMessage,
      applied: false,
      sessionTokens,
      incomingTokens,
      projectedTokens,
      thresholdTokens,
      contextWindowTokens,
      reason: 'below_threshold',
    };
  }

  const nextMessage = injectCompactMetadata(requestMessage, {
    compactManual: true,
    preflightCompact: {
      trigger: 'session_projection_threshold',
      targetAgentId,
      sessionTokens,
      incomingTokens,
      projectedTokens,
      thresholdTokens,
      contextWindowTokens,
      latestCompactIndex: typeof session.latestCompactIndex === 'number' ? session.latestCompactIndex : -1,
      sessionMessageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      requestedAt: new Date().toISOString(),
    },
  });

  log.info('Preflight compact requested before dispatch', {
    sessionId: session.id,
    targetAgentId,
    sessionTokens,
    incomingTokens,
    projectedTokens,
    thresholdTokens,
    contextWindowTokens,
    latestCompactIndex: session.latestCompactIndex,
  });

  return {
    requestMessage: nextMessage,
    applied: true,
    sessionTokens,
    incomingTokens,
    projectedTokens,
    thresholdTokens,
    contextWindowTokens,
    reason: 'preflight_manual_compact',
  };
}
