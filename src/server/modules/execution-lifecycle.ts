import { logger } from '../../core/logger.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { isObjectRecord } from '../common/object.js';

const log = logger.module('execution-lifecycle');

export type ExecutionLifecycleStage =
  | 'received'
  | 'session_bound'
  | 'dispatching'
  | 'running'
  | 'waiting_user'
  | 'waiting_tool'
  | 'waiting_model'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface ExecutionLifecycleState {
  stage: ExecutionLifecycleStage;
  substage?: string;
  startedAt: string;
  lastTransitionAt: string;
  retryCount: number;
  finishReason?: string;
  lastError?: string;
  updatedBy?: string;
  messageId?: string;
  dispatchId?: string;
  turnId?: string;
  targetAgentId?: string;
  toolName?: string;
  detail?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  recoveryAction?: string;
  delivery?: string;
}

export interface ExecutionLifecycleTransition {
  stage: ExecutionLifecycleStage;
  substage?: string;
  /**
   * Allow transition from terminal lifecycle stages to non-terminal stages.
   * Use sparingly for explicit state handoff events (e.g. waiting_for_user).
   */
  allowFromTerminal?: boolean;
  finishReason?: string | null;
  lastError?: string | null;
  updatedBy?: string;
  messageId?: string;
  dispatchId?: string;
  turnId?: string;
  targetAgentId?: string;
  toolName?: string;
  detail?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  recoveryAction?: string | null;
  delivery?: string | null;
  incrementRetry?: boolean;
}

const STAGES = new Set<ExecutionLifecycleStage>([
  'received',
  'session_bound',
  'dispatching',
  'running',
  'waiting_user',
  'waiting_tool',
  'waiting_model',
  'retrying',
  'completed',
  'failed',
  'interrupted',
]);

const TERMINAL_STAGES = new Set<ExecutionLifecycleStage>([
  'completed',
  'failed',
  'interrupted',
]);

const INTERRUPTION_KEYWORDS = [
  'interrupt',
  'interrupted',
  'superseded',
  'aborted',
  'abort',
  'sigterm',
  'terminated',
];

const CANCELLATION_KEYWORDS = [
  'cancelled',
  'canceled',
  'cancel',
];

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error.trim();
  if (error instanceof Error) return error.message.trim();
  return String(error ?? '').trim();
}

function containsAnyKeyword(text: string, keywords: string[]): boolean {
  for (const keyword of keywords) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

export type ExecutionErrorDisposition = {
  stage: 'failed' | 'interrupted';
  reason: 'failed' | 'interrupted' | 'cancelled';
  message: string;
};

export function classifyExecutionErrorDisposition(error: unknown): ExecutionErrorDisposition {
  const message = normalizeErrorMessage(error);
  const normalized = message.toLowerCase();
  if (containsAnyKeyword(normalized, CANCELLATION_KEYWORDS)) {
    return {
      stage: 'interrupted',
      reason: 'cancelled',
      message,
    };
  }
  if (containsAnyKeyword(normalized, INTERRUPTION_KEYWORDS)) {
    return {
      stage: 'interrupted',
      reason: 'interrupted',
      message,
    };
  }
  return {
    stage: 'failed',
    reason: 'failed',
    message,
  };
}

export function formatUserFacingExecutionError(
  error: unknown,
  fallbackFailureText = '处理失败，请稍后再试',
): string {
  const disposition = classifyExecutionErrorDisposition(error);
  const message = disposition.message;
  if (disposition.reason === 'cancelled') {
    return message.length > 0 ? `已取消：${message}` : '已取消，请重试。';
  }
  if (disposition.reason === 'interrupted') {
    return message.length > 0 ? `已中断：${message}` : '已中断，请重试。';
  }
  return message.length > 0 ? `处理失败：${message}` : fallbackFailureText;
}

export function parseExecutionLifecycleState(value: unknown): ExecutionLifecycleState | null {
  if (!isObjectRecord(value)) return null;
  const stage = asOptionalString(value.stage);
  if (!stage || !STAGES.has(stage as ExecutionLifecycleStage)) return null;
  const startedAt = asOptionalString(value.startedAt);
  const lastTransitionAt = asOptionalString(value.lastTransitionAt);
  if (!startedAt || !lastTransitionAt) return null;
  const retryCountRaw = typeof value.retryCount === 'number' ? value.retryCount : 0;
  return {
    stage: stage as ExecutionLifecycleStage,
    startedAt,
    lastTransitionAt,
    retryCount: Number.isFinite(retryCountRaw) ? Math.max(0, Math.floor(retryCountRaw)) : 0,
    ...(asOptionalString(value.finishReason) ? { finishReason: asOptionalString(value.finishReason) } : {}),
    ...(asOptionalString(value.substage) ? { substage: asOptionalString(value.substage) } : {}),
    ...(asOptionalString(value.lastError) ? { lastError: asOptionalString(value.lastError) } : {}),
    ...(asOptionalString(value.updatedBy) ? { updatedBy: asOptionalString(value.updatedBy) } : {}),
    ...(asOptionalString(value.messageId) ? { messageId: asOptionalString(value.messageId) } : {}),
    ...(asOptionalString(value.dispatchId) ? { dispatchId: asOptionalString(value.dispatchId) } : {}),
    ...(asOptionalString(value.turnId) ? { turnId: asOptionalString(value.turnId) } : {}),
    ...(asOptionalString(value.targetAgentId) ? { targetAgentId: asOptionalString(value.targetAgentId) } : {}),
    ...(asOptionalString(value.toolName) ? { toolName: asOptionalString(value.toolName) } : {}),
    ...(asOptionalString(value.detail) ? { detail: asOptionalString(value.detail) } : {}),
    ...(typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
      ? { timeoutMs: Math.floor(value.timeoutMs) }
      : {}),
    ...(typeof value.retryDelayMs === 'number' && Number.isFinite(value.retryDelayMs) && value.retryDelayMs >= 0
      ? { retryDelayMs: Math.floor(value.retryDelayMs) }
      : {}),
    ...(asOptionalString(value.recoveryAction) ? { recoveryAction: asOptionalString(value.recoveryAction) } : {}),
    ...(asOptionalString(value.delivery) ? { delivery: asOptionalString(value.delivery) } : {}),
  };
}

export function getExecutionLifecycleState(
  sessionManager: SessionManager,
  sessionId: string,
): ExecutionLifecycleState | null {
  if (!sessionId) return null;
  if (typeof (sessionManager as { getSession?: unknown }).getSession !== 'function') return null;
  const session = sessionManager.getSession(sessionId);
  if (!session || !isObjectRecord(session.context)) return null;
  return parseExecutionLifecycleState(session.context.executionLifecycle);
}

export function transitionExecutionLifecycle(
  current: ExecutionLifecycleState | null,
  transition: ExecutionLifecycleTransition,
  nowIso = new Date().toISOString(),
): ExecutionLifecycleState {
  if (
    current
    && TERMINAL_STAGES.has(current.stage)
    && !TERMINAL_STAGES.has(transition.stage)
    && transition.stage !== 'received'
    && transition.allowFromTerminal !== true
  ) {
    log.warn('Skip lifecycle regression transition from terminal stage', {
      fromStage: current.stage,
      toStage: transition.stage,
      substage: transition.substage,
      updatedBy: transition.updatedBy,
      sessionMessageId: transition.messageId,
    });
    return current;
  }

  const startedAt = transition.stage === 'received' || !current
    ? nowIso
    : current.startedAt;
  const retryCountBase = transition.stage === 'received' || !current ? 0 : current.retryCount;
  const retryCount = transition.incrementRetry ? retryCountBase + 1 : retryCountBase;
  const next: ExecutionLifecycleState = {
    stage: transition.stage,
    startedAt,
    lastTransitionAt: nowIso,
    retryCount,
    ...(transition.finishReason === null
      ? {}
      : transition.finishReason
        ? { finishReason: transition.finishReason }
        : current?.finishReason
          ? { finishReason: current.finishReason }
          : {}),
    ...(transition.substage ? { substage: transition.substage } : {}),
    ...(transition.updatedBy ? { updatedBy: transition.updatedBy } : current?.updatedBy ? { updatedBy: current.updatedBy } : {}),
    ...(transition.messageId ? { messageId: transition.messageId } : current?.messageId ? { messageId: current.messageId } : {}),
    ...(transition.dispatchId ? { dispatchId: transition.dispatchId } : current?.dispatchId ? { dispatchId: current.dispatchId } : {}),
    ...(transition.turnId ? { turnId: transition.turnId } : current?.turnId ? { turnId: current.turnId } : {}),
    ...(transition.targetAgentId ? { targetAgentId: transition.targetAgentId } : current?.targetAgentId ? { targetAgentId: current.targetAgentId } : {}),
    ...(transition.toolName ? { toolName: transition.toolName } : current?.toolName ? { toolName: current.toolName } : {}),
    ...(transition.detail ? { detail: transition.detail } : current?.detail ? { detail: current.detail } : {}),
    ...(typeof transition.timeoutMs === 'number' && Number.isFinite(transition.timeoutMs) && transition.timeoutMs > 0
      ? { timeoutMs: Math.floor(transition.timeoutMs) }
      : current?.timeoutMs
        ? { timeoutMs: current.timeoutMs }
        : {}),
    ...(typeof transition.retryDelayMs === 'number' && Number.isFinite(transition.retryDelayMs) && transition.retryDelayMs >= 0
      ? { retryDelayMs: Math.floor(transition.retryDelayMs) }
      : current?.retryDelayMs !== undefined
        ? { retryDelayMs: current.retryDelayMs }
        : {}),
    ...(transition.recoveryAction === null
      ? {}
      : transition.recoveryAction
        ? { recoveryAction: transition.recoveryAction }
        : current?.recoveryAction
          ? { recoveryAction: current.recoveryAction }
          : {}),
    ...(transition.delivery === null
      ? {}
      : transition.delivery
        ? { delivery: transition.delivery }
        : current?.delivery
          ? { delivery: current.delivery }
          : {}),
  };

  if (transition.lastError === null) {
    // Explicit clear.
  } else if (transition.lastError) {
    next.lastError = transition.lastError;
  } else if (current?.lastError && transition.stage !== 'completed') {
    next.lastError = current.lastError;
  }

  return next;
}

export function applyExecutionLifecycleTransition(
  sessionManager: SessionManager,
  sessionId: string,
  transition: ExecutionLifecycleTransition,
): ExecutionLifecycleState | null {
  if (!sessionId || sessionId.trim().length === 0) return null;
  if (typeof (sessionManager as { updateContext?: unknown }).updateContext !== 'function') return null;
  const normalizeSessionId = sessionId.trim();
  let resolvedSessionId = normalizeSessionId;
  if (!sessionManager.getSession(normalizeSessionId)) {
    const fallbackSystemSession = (sessionManager as {
      getOrCreateSystemSession?: () => { id?: string };
    }).getOrCreateSystemSession;
    const isSystemAlias = normalizeSessionId === 'system-default-session'
      || normalizeSessionId === 'system-1'
      || normalizeSessionId.startsWith('system-');
    if (isSystemAlias && typeof fallbackSystemSession === 'function') {
      const systemSession = fallbackSystemSession.call(sessionManager);
      if (systemSession?.id && typeof systemSession.id === 'string' && systemSession.id.trim().length > 0) {
        resolvedSessionId = systemSession.id.trim();
      }
    }
  }

  const current = getExecutionLifecycleState(sessionManager, resolvedSessionId);
  const next = transitionExecutionLifecycle(current, transition);
  if (current && next === current) {
    return current;
  }
  const updated = sessionManager.updateContext(resolvedSessionId, {
    executionLifecycle: next,
  });
  if (!updated) {
    log.warn('Failed to persist execution lifecycle transition: session not found', {
      sessionId: normalizeSessionId,
      resolvedSessionId: resolvedSessionId !== normalizeSessionId ? resolvedSessionId : undefined,
      stage: transition.stage,
      substage: transition.substage,
    });
    return null;
  }
  log.debug('Execution lifecycle transition applied', {
    sessionId: resolvedSessionId,
    originalSessionId: resolvedSessionId !== normalizeSessionId ? normalizeSessionId : undefined,
    fromStage: current?.stage,
    toStage: next.stage,
    substage: next.substage,
    retryCount: next.retryCount,
    updatedBy: next.updatedBy,
  });
  return next;
}

export function resolveLifecycleStageFromResultStatus(
  status: unknown,
): ExecutionLifecycleStage | null {
  if (typeof status !== 'string') return null;
  const normalized = status.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'succeeded' || normalized === 'success') {
    return 'completed';
  }
  if (normalized === 'failed' || normalized === 'error' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'failed';
  }
  if (normalized === 'queued' || normalized === 'processing' || normalized === 'running' || normalized === 'accepted') {
    return 'dispatching';
  }
  return null;
}
