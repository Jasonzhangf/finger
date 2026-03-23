import { isObjectRecord } from '../../common/object.js';
import type { AgentRuntimeDeps } from './types.js';
import type { HeartbeatMailboxMessage } from '../heartbeat-mailbox.js';

export type MailboxToolContext = {
  agentId?: string;
  sessionId?: string;
};

export type MailboxTerminalStatus = 'completed' | 'failed';

export interface MailboxListInput {
  target?: string;
  status?: HeartbeatMailboxMessage['status'];
  category?: string;
  unreadOnly?: boolean;
  limit?: number;
}

export interface MailboxReadInput {
  id: string;
  target?: string;
}

export interface MailboxAckInput {
  id: string;
  target?: string;
  status?: MailboxTerminalStatus;
  result?: unknown;
  error?: string;
  summary?: string;
}

export interface MailboxReadAllInput extends MailboxListInput {
  ids?: string[];
}

export interface MailboxRemoveAllInput extends MailboxListInput {
  ids?: string[];
}

export function resolveMailboxTarget(rawInput: unknown, context?: MailboxToolContext): string {
  const explicitTarget = isObjectRecord(rawInput) && typeof rawInput.target === 'string'
    ? rawInput.target.trim()
    : '';
  if (explicitTarget.length > 0) return explicitTarget;
  const agentTarget = typeof context?.agentId === 'string' ? context.agentId.trim() : '';
  if (agentTarget.length > 0) return agentTarget;
  return 'finger-system-agent';
}

export function normalizeMailboxMessage(message: HeartbeatMailboxMessage): Record<string, unknown> {
  return {
    id: message.id,
    seq: message.seq,
    status: message.status,
    sender: message.sender,
    channel: message.channel,
    category: message.category,
    priority: message.priority,
    content: message.content,
    result: message.result,
    error: message.error,
    sessionId: message.sessionId,
    threadId: message.threadId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    readAt: message.readAt,
    ackAt: message.ackAt,
  };
}

export function getShortDescription(message: HeartbeatMailboxMessage, maxLength = 100): string {
  let desc = '';
  if (typeof message.content === 'string') {
    desc = message.content;
  } else if (isObjectRecord(message.content)) {
    desc = typeof message.content.text === 'string'
      ? message.content.text
      : typeof message.content.summary === 'string'
        ? message.content.summary
        : JSON.stringify(message.content);
  } else {
    desc = JSON.stringify(message.content);
  }
  return desc.length > maxLength ? `${desc.substring(0, maxLength)}...` : desc;
}

export function resolveMailboxAckStatus(input: MailboxAckInput): MailboxTerminalStatus {
  if (input.status === 'failed') return 'failed';
  if (typeof input.error === 'string' && input.error.trim().length > 0) return 'failed';
  return 'completed';
}

export function resolveMailboxAckResult(input: MailboxAckInput): unknown {
  if (input.result !== undefined) return input.result;
  if (typeof input.summary === 'string' && input.summary.trim().length > 0) {
    return { summary: input.summary.trim() };
  }
  return undefined;
}

function extractDispatchPayload(message: HeartbeatMailboxMessage): {
  dispatchId: string;
  sourceAgentId: string;
  targetAgentId: string;
  sessionId?: string;
  workflowId?: string;
  assignment?: Record<string, unknown>;
} | null {
  if (!isObjectRecord(message.content)) return null;
  if (message.content.type !== 'dispatch-task') return null;
  const dispatchId = typeof message.content.dispatchId === 'string' ? message.content.dispatchId.trim() : '';
  const sourceAgentId = typeof message.content.sourceAgentId === 'string' ? message.content.sourceAgentId.trim() : '';
  const targetAgentId = typeof message.content.targetAgentId === 'string'
    ? message.content.targetAgentId.trim()
    : message.target;
  if (dispatchId.length === 0 || sourceAgentId.length === 0 || targetAgentId.trim().length === 0) {
    return null;
  }
  return {
    dispatchId,
    sourceAgentId,
    targetAgentId: targetAgentId.trim(),
    ...(typeof message.content.sessionId === 'string' && message.content.sessionId.trim().length > 0
      ? { sessionId: message.content.sessionId.trim() }
      : {}),
    ...(typeof message.content.workflowId === 'string' && message.content.workflowId.trim().length > 0
      ? { workflowId: message.content.workflowId.trim() }
      : {}),
    ...(isObjectRecord(message.content.assignment) ? { assignment: message.content.assignment } : {}),
  };
}

export async function emitDispatchMailboxEvent(
  deps: AgentRuntimeDeps,
  message: HeartbeatMailboxMessage,
  status: 'processing' | 'completed' | 'failed',
  detail?: {
    result?: unknown;
    error?: string;
  },
): Promise<void> {
  const dispatch = extractDispatchPayload(message);
  if (!dispatch) return;
  await deps.eventBus.emit({
    type: 'agent_runtime_dispatch',
    agentId: dispatch.targetAgentId,
    sessionId: dispatch.sessionId ?? 'unknown',
    timestamp: new Date().toISOString(),
    payload: {
      dispatchId: dispatch.dispatchId,
      sourceAgentId: dispatch.sourceAgentId,
      targetAgentId: dispatch.targetAgentId,
      status,
      blocking: false,
      ...(dispatch.sessionId ? { sessionId: dispatch.sessionId } : {}),
      ...(dispatch.workflowId ? { workflowId: dispatch.workflowId } : {}),
      ...(dispatch.assignment ? { assignment: dispatch.assignment } : {}),
      ...(detail?.result !== undefined ? { result: detail.result } : {}),
      ...(detail?.error ? { error: detail.error } : {}),
    },
  });
}
