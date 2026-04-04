import { isObjectRecord } from '../../common/object.js';
import {
  collectMaskedToolInputRecords,
  readMaskedNumber,
  readMaskedString,
  readMaskedStringArray,
} from '../../../common/tool-input-mask.js';
import type { AgentRuntimeDeps, AskToolRequest } from './types.js';

type AskDecisionImpact = 'critical' | 'major' | 'normal';

function normalizeDecisionImpact(value: unknown): AskDecisionImpact {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'critical'
    || normalized === 'high'
    || normalized === 'p0'
    || normalized === 'blocker'
  ) {
    return 'critical';
  }
  if (
    normalized === 'major'
    || normalized === 'medium'
    || normalized === 'p1'
  ) {
    return 'major';
  }
  return 'normal';
}

function normalizeBlockingReason(rawInput: Record<string, unknown>): string | undefined {
  const candidates = [
    rawInput.blocking_reason,
    rawInput.blockingReason,
    rawInput.reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function normalizeOptionalScopeId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLikelyApprovalOnlyAsk(question: string, options?: string[]): boolean {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return false;
  const approvalQuestionPattern = /(要我|是否|能否|可否|继续吗|现在开始吗|要不要|do you want|should i|can i proceed)/i;
  const destructivePattern = /(删除|drop|destroy|migrate|发布|release|production|prod|凭证|credential|token|密钥|秘钥|账单|付费|支付|legal|compliance|合规|不可逆|irreversible|risk|风险)/i;
  if (destructivePattern.test(normalized)) return false;
  const binaryOptions = Array.isArray(options)
    ? options
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0)
    : [];
  const yesNoOnly = binaryOptions.length === 2
    && (
      (binaryOptions.includes('是') && binaryOptions.includes('否'))
      || (binaryOptions.includes('yes') && binaryOptions.includes('no'))
      || (binaryOptions.includes('继续') && binaryOptions.includes('停止'))
    );
  return approvalQuestionPattern.test(normalized) || yesNoOnly;
}

export function parseAskToolInput(rawInput: unknown): AskToolRequest {
  const records = collectMaskedToolInputRecords(rawInput);
  if (records.length === 0) {
    throw new Error('user.ask input must be object');
  }
  const primary = records[0] ?? {};
  const question = readMaskedString(rawInput, ['question', 'prompt', 'message', 'ask']) ?? '';
  if (!question) {
    throw new Error('user.ask question is required');
  }
  const options = readMaskedStringArray(rawInput, ['options', 'choices', 'selections']);
  const timeoutMs = readMaskedNumber(rawInput, ['timeout_ms', 'timeoutMs', 'timeout']);
  const decisionImpact = normalizeDecisionImpact(
    readMaskedString(rawInput, ['decision_impact', 'decisionImpact', 'importance', 'blocker_level', 'blockerLevel']),
  );
  const blockingReason = readMaskedString(rawInput, ['blocking_reason', 'blockingReason', 'reason'])
    ?? normalizeBlockingReason(primary);
  const runtimeContextRecord = records.find((record) => isObjectRecord(record._runtime_context));
  const runtimeContext = isObjectRecord(runtimeContextRecord?._runtime_context) ? runtimeContextRecord._runtime_context : {};
  const agentId = readMaskedString(rawInput, ['agent_id', 'agentId'])
    ?? (typeof runtimeContext.agent_id === 'string' ? runtimeContext.agent_id.trim() : undefined);
  const contextText = readMaskedString(rawInput, ['context', 'details', 'background']);
  const sessionId = readMaskedString(rawInput, ['session_id', 'sessionId']);
  const workflowId = readMaskedString(rawInput, ['workflow_id', 'workflowId']);
  const epicId = readMaskedString(rawInput, ['epic_id', 'epicId']);
  const channelId = normalizeOptionalScopeId(readMaskedString(rawInput, ['channel_id', 'channelId']))
    ?? normalizeOptionalScopeId(runtimeContext.channel_id)
    ?? normalizeOptionalScopeId(runtimeContext.channelId);
  const userId = normalizeOptionalScopeId(readMaskedString(rawInput, ['user_id', 'userId']))
    ?? normalizeOptionalScopeId(runtimeContext.user_id)
    ?? normalizeOptionalScopeId(runtimeContext.userId)
    ?? normalizeOptionalScopeId(runtimeContext.channel_user_id)
    ?? normalizeOptionalScopeId(runtimeContext.channelUserId);
  const groupId = normalizeOptionalScopeId(readMaskedString(rawInput, ['group_id', 'groupId']))
    ?? normalizeOptionalScopeId(runtimeContext.group_id)
    ?? normalizeOptionalScopeId(runtimeContext.groupId)
    ?? normalizeOptionalScopeId(runtimeContext.channel_group_id)
    ?? normalizeOptionalScopeId(runtimeContext.channelGroupId);
  return {
    question,
    ...(options && options.length > 0 ? { options } : {}),
    ...(contextText ? { context: contextText } : {}),
    ...(blockingReason ? { blockingReason } : {}),
    decisionImpact,
    ...(typeof agentId === 'string' && agentId.trim().length > 0 ? { agentId: agentId.trim() } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(epicId ? { epicId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(userId ? { userId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
      ? { timeoutMs: Math.max(1_000, Math.floor(timeoutMs)) }
      : {}),
  };
}

export async function runBlockingAsk(deps: AgentRuntimeDeps, request: AskToolRequest): Promise<{
  ok: boolean;
  requestId: string;
  answer?: string;
  selectedOption?: string;
  timedOut?: boolean;
}> {
  const decisionImpact = request.decisionImpact ?? 'normal';
  const approvalOnly = isLikelyApprovalOnlyAsk(request.question, request.options);
  const hasExplicitBlocker = typeof request.blockingReason === 'string' && request.blockingReason.trim().length > 0;
  if (approvalOnly && decisionImpact === 'normal' && !hasExplicitBlocker) {
    throw new Error(
      'user.ask is reserved for critical blocking decisions only; avoid approval-only yes/no prompts without blocker context.',
    );
  }

  const contextWithBlocker = (
    hasExplicitBlocker
      ? [
          request.context?.trim() ?? '',
          `[blocking_reason] ${request.blockingReason!.trim()}`,
          `[decision_impact] ${decisionImpact}`,
        ].filter((item) => item.length > 0).join('\n')
      : request.context
  );

  const fallbackSessionId = request.sessionId ?? deps.runtime.getCurrentSession()?.id;
  const fallbackSession = fallbackSessionId ? deps.sessionManager.getSession(fallbackSessionId) : null;
  const fallbackContext = (fallbackSession?.context && typeof fallbackSession.context === 'object')
    ? fallbackSession.context as Record<string, unknown>
    : {};
  const fallbackChannelId = normalizeOptionalScopeId(fallbackContext.channelId);
  const fallbackUserId = normalizeOptionalScopeId(fallbackContext.channelUserId);
  const fallbackGroupId = normalizeOptionalScopeId(fallbackContext.channelGroupId);

  const opened = deps.askManager.open({
    question: request.question,
    options: request.options,
    context: contextWithBlocker,
    agentId: request.agentId,
    sessionId: fallbackSessionId,
    workflowId: request.workflowId,
    epicId: request.epicId,
    ...(request.channelId ? { channelId: request.channelId } : (fallbackChannelId ? { channelId: fallbackChannelId } : {})),
    ...(request.userId ? { userId: request.userId } : (fallbackUserId ? { userId: fallbackUserId } : {})),
    ...(request.groupId ? { groupId: request.groupId } : (fallbackGroupId ? { groupId: fallbackGroupId } : {})),
    timeoutMs: request.timeoutMs,
  });

  void deps.eventBus.emit({
    type: 'waiting_for_user',
    workflowId: request.workflowId ?? request.epicId ?? 'ask',
    sessionId: fallbackSessionId ?? 'default',
    timestamp: new Date().toISOString(),
    payload: {
      reason: 'confirmation_required',
      options: (request.options ?? []).map((label) => ({
        id: label,
        label,
        description: 'orchestrator ask option',
      })),
      context: {
        requestId: opened.pending.requestId,
        question: opened.pending.question,
        ...(opened.pending.options ? { options: opened.pending.options } : {}),
        ...(opened.pending.context ? { context: opened.pending.context } : {}),
        ...(opened.pending.epicId ? { epicId: opened.pending.epicId } : {}),
        ...(opened.pending.agentId ? { agentId: opened.pending.agentId } : {}),
      },
    },
  });

  deps.broadcast({
    type: 'user_question',
    payload: opened.pending,
    timestamp: new Date().toISOString(),
  });

  const resolved = await opened.result;
  void deps.eventBus.emit({
    type: 'user_decision_received',
    workflowId: request.workflowId ?? request.epicId ?? 'ask',
    sessionId: fallbackSessionId ?? 'default',
    timestamp: new Date().toISOString(),
    payload: {
      decision: resolved.answer ?? (resolved.timedOut ? 'timeout' : 'empty'),
      context: {
        requestId: resolved.requestId,
        ...(resolved.selectedOption ? { selectedOption: resolved.selectedOption } : {}),
        ...(resolved.timedOut ? { timedOut: true } : {}),
      },
    },
  });

  return {
    ok: resolved.ok,
    requestId: resolved.requestId,
    ...(resolved.answer ? { answer: resolved.answer } : {}),
    ...(resolved.selectedOption ? { selectedOption: resolved.selectedOption } : {}),
    ...(resolved.timedOut ? { timedOut: true } : {}),
  };
}
