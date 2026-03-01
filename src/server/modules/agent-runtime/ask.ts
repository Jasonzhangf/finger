import { isObjectRecord } from '../../common/object.js';
import type { AgentRuntimeDeps, AskToolRequest } from './types.js';

export function parseAskToolInput(rawInput: unknown): AskToolRequest {
  if (!isObjectRecord(rawInput)) {
    throw new Error('user.ask input must be object');
  }
  const question = typeof rawInput.question === 'string' ? rawInput.question.trim() : '';
  if (!question) {
    throw new Error('user.ask question is required');
  }
  const options = Array.isArray(rawInput.options)
    ? rawInput.options
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : undefined;
  const timeoutMs = typeof rawInput.timeout_ms === 'number'
    ? rawInput.timeout_ms
    : typeof rawInput.timeoutMs === 'number'
      ? rawInput.timeoutMs
      : undefined;
  const runtimeContext = isObjectRecord(rawInput._runtime_context) ? rawInput._runtime_context : {};
  const agentId = typeof rawInput.agent_id === 'string'
    ? rawInput.agent_id
    : typeof rawInput.agentId === 'string'
      ? rawInput.agentId
      : typeof runtimeContext.agent_id === 'string'
        ? runtimeContext.agent_id
        : undefined;
  return {
    question,
    ...(options && options.length > 0 ? { options } : {}),
    ...(typeof rawInput.context === 'string' && rawInput.context.trim().length > 0 ? { context: rawInput.context.trim() } : {}),
    ...(typeof agentId === 'string' && agentId.trim().length > 0 ? { agentId: agentId.trim() } : {}),
    ...(typeof rawInput.session_id === 'string' && rawInput.session_id.trim().length > 0
      ? { sessionId: rawInput.session_id.trim() }
      : typeof rawInput.sessionId === 'string' && rawInput.sessionId.trim().length > 0
        ? { sessionId: rawInput.sessionId.trim() }
        : {}),
    ...(typeof rawInput.workflow_id === 'string' && rawInput.workflow_id.trim().length > 0
      ? { workflowId: rawInput.workflow_id.trim() }
      : typeof rawInput.workflowId === 'string' && rawInput.workflowId.trim().length > 0
        ? { workflowId: rawInput.workflowId.trim() }
        : {}),
    ...(typeof rawInput.epic_id === 'string' && rawInput.epic_id.trim().length > 0
      ? { epicId: rawInput.epic_id.trim() }
      : typeof rawInput.epicId === 'string' && rawInput.epicId.trim().length > 0
        ? { epicId: rawInput.epicId.trim() }
        : {}),
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
  const opened = deps.askManager.open({
    question: request.question,
    options: request.options,
    context: request.context,
    agentId: request.agentId,
    sessionId: request.sessionId ?? deps.runtime.getCurrentSession()?.id,
    workflowId: request.workflowId,
    epicId: request.epicId,
    timeoutMs: request.timeoutMs,
  });

  void deps.eventBus.emit({
    type: 'waiting_for_user',
    workflowId: request.workflowId ?? request.epicId ?? 'ask',
    sessionId: request.sessionId ?? deps.runtime.getCurrentSession()?.id ?? 'default',
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
    sessionId: request.sessionId ?? deps.runtime.getCurrentSession()?.id ?? 'default',
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
