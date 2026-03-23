import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import type { AgentRuntimeDeps } from './types.js';
import { heartbeatMailbox, type HeartbeatMailboxMessage } from '../heartbeat-mailbox.js';

const log = logger.module('AgentRuntimeMailbox');

type MailboxToolContext = {
  agentId?: string;
  sessionId?: string;
};

type MailboxTerminalStatus = 'completed' | 'failed';

interface MailboxListInput {
  target?: string;
  status?: HeartbeatMailboxMessage['status'];
  unreadOnly?: boolean;
  limit?: number;
}

interface MailboxReadInput {
  id: string;
  target?: string;
}

interface MailboxAckInput {
  id: string;
  target?: string;
  status?: MailboxTerminalStatus;
  result?: unknown;
  error?: string;
  summary?: string;
}

function resolveMailboxTarget(rawInput: unknown, context?: MailboxToolContext): string {
  const explicitTarget = isObjectRecord(rawInput) && typeof rawInput.target === 'string'
    ? rawInput.target.trim()
    : '';
  if (explicitTarget.length > 0) return explicitTarget;
  const agentTarget = typeof context?.agentId === 'string' ? context.agentId.trim() : '';
  if (agentTarget.length > 0) return agentTarget;
  return 'finger-system-agent';
}

function normalizeMailboxMessage(message: HeartbeatMailboxMessage): Record<string, unknown> {
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

function getShortDescription(message: HeartbeatMailboxMessage, maxLength = 100): string {
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

function resolveMailboxAckStatus(input: MailboxAckInput): MailboxTerminalStatus {
  if (input.status === 'failed') return 'failed';
  if (typeof input.error === 'string' && input.error.trim().length > 0) return 'failed';
  return 'completed';
}

function resolveMailboxAckResult(input: MailboxAckInput): unknown {
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

async function emitDispatchMailboxEvent(
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
    sessionId: dispatch.sessionId,
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

async function handleMailboxStatus(input: unknown, context: MailboxToolContext): Promise<unknown> {
  const target = resolveMailboxTarget(input, context);
  const messages = heartbeatMailbox.list(target);
  const unread = messages.filter((m) => !m.readAt && m.status === 'pending');
  const pending = messages.filter((m) => m.status === 'pending');
  const processing = messages.filter((m) => m.status === 'processing');

  return {
    success: true,
    target,
    counts: {
      total: messages.length,
      unread: unread.length,
      pending: pending.length,
      processing: processing.length,
    },
    recentUnread: unread.slice(0, 5).map((m) => ({
      id: m.id,
      seq: m.seq,
      sender: m.sender,
      category: m.category,
      priority: m.priority,
      shortDescription: getShortDescription(m, 80),
      createdAt: m.createdAt,
    })),
  };
}

async function handleMailboxList(input: unknown, context: MailboxToolContext): Promise<unknown> {
  const parsed = isObjectRecord(input) ? input as MailboxListInput : {};
  const target = resolveMailboxTarget(input, context);
  let messages = heartbeatMailbox.list(target, {
    status: parsed.status,
    limit: typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
      ? Math.max(1, Math.floor(parsed.limit))
      : undefined,
  });

  if (parsed.unreadOnly) {
    messages = messages.filter((message) => !message.readAt);
  }

  messages = [...messages].sort((a, b) => b.seq - a.seq);

  return {
    success: true,
    target,
    count: messages.length,
    total: messages.length,
    messages: messages.map((message) => ({
      id: message.id,
      seq: message.seq,
      status: message.status,
      sender: message.sender,
      channel: message.channel,
      category: message.category,
      priority: message.priority,
      shortDescription: getShortDescription(message),
      readAt: message.readAt,
      ackAt: message.ackAt,
      createdAt: message.createdAt,
    })),
  };
}

async function handleMailboxRead(deps: AgentRuntimeDeps, input: unknown, context: MailboxToolContext): Promise<unknown> {
  if (!isObjectRecord(input) || typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new Error('mailbox.read id is required');
  }

  const target = resolveMailboxTarget(input, context);
  const id = input.id.trim();
  const before = heartbeatMailbox.get(target, id);
  if (!before) {
    return { success: false, error: `Message not found: ${id}` };
  }

  const readResult = heartbeatMailbox.markRead(target, id);
  const updated = readResult.updated ?? heartbeatMailbox.get(target, id);
  if (!readResult.read || !updated) {
    return { success: false, error: `Failed to read message: ${id}` };
  }

  if (before.status !== updated.status && updated.status === 'processing') {
    await emitDispatchMailboxEvent(deps, updated, 'processing', {
      result: {
        status: 'processing_mailbox',
        via: 'mailbox',
        mailboxMessageId: updated.id,
      },
    });
  }

  return {
    success: true,
    target,
    handshake: {
      movedToProcessing: before.status !== updated.status && updated.status === 'processing',
      requiresAck: updated.category !== 'notification' && !updated.ackAt,
    },
    message: normalizeMailboxMessage(updated),
  };
}

async function handleMailboxAck(deps: AgentRuntimeDeps, input: unknown, context: MailboxToolContext): Promise<unknown> {
  if (!isObjectRecord(input) || typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new Error('mailbox.ack id is required');
  }

  const parsed = input as MailboxAckInput;
  const target = resolveMailboxTarget(parsed, context);
  const id = parsed.id.trim();
  const current = heartbeatMailbox.get(target, id);
  if (!current) {
    return { success: false, error: `Message not found: ${id}` };
  }

  const finalStatus = resolveMailboxAckStatus(parsed);
  const finalError = typeof parsed.error === 'string' && parsed.error.trim().length > 0
    ? parsed.error.trim()
    : undefined;
  const finalResult = resolveMailboxAckResult(parsed);
  const ackResult = heartbeatMailbox.ack(target, id, {
    status: finalStatus,
    result: finalResult,
    error: finalError,
  });

  if (!ackResult.acked || !ackResult.updated) {
    return {
      success: false,
      error: ackResult.error ?? `Failed to acknowledge message: ${id}`,
    };
  }

  const updated = ackResult.updated;

  const dispatchResult = finalResult !== undefined
    ? isObjectRecord(finalResult)
      ? {
          ...finalResult,
          status: `${finalStatus}_mailbox`,
          via: 'mailbox',
          mailboxMessageId: updated.id,
          ...(typeof finalResult.summary === 'string' && finalResult.summary.trim().length > 0
            ? {}
            : typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
              ? { summary: parsed.summary.trim() }
              : {}),
        }
      : {
          status: `${finalStatus}_mailbox`,
          via: 'mailbox',
          mailboxMessageId: updated.id,
          output: finalResult,
          ...(typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
            ? { summary: parsed.summary.trim() }
            : typeof finalResult === 'string' && finalResult.trim().length > 0
              ? { summary: finalResult.trim() }
              : {}),
        }
    : {
        status: `${finalStatus}_mailbox`,
        via: 'mailbox',
        mailboxMessageId: updated.id,
        ...(typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
          ? { summary: parsed.summary.trim() }
          : {}),
      };

  await emitDispatchMailboxEvent(deps, updated, finalStatus, {
    result: dispatchResult,
    error: finalStatus === 'failed' ? finalError ?? updated.error : undefined,
  });

  return {
    success: true,
    target,
    status: updated.status,
    ackAt: updated.ackAt,
    message: normalizeMailboxMessage(updated),
  };
}

export function registerMailboxRuntimeTools(deps: AgentRuntimeDeps): string[] {
  deps.runtime.registerTool({
    name: 'mailbox.status',
    description: 'Get mailbox overview: unread/pending/processing counts for the current agent mailbox.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxStatus(input, context ?? {}),
  });

  deps.runtime.registerTool({
    name: 'mailbox.list',
    description: 'List mailbox messages with summary metadata. Supports status filtering and unreadOnly.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxList(input, context ?? {}),
  });

  deps.runtime.registerTool({
    name: 'mailbox.read',
    description: 'Read one mailbox message. First read will claim the task by moving pending → processing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        target: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxRead(deps, input, context ?? {}),
  });

  deps.runtime.registerTool({
    name: 'mailbox.ack',
    description: 'Finish a mailbox task after mailbox.read(id). Supports completed/failed and result/error payloads.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        target: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'failed'] },
        result: {},
        error: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxAck(deps, input, context ?? {}),
  });

  log.info('Mailbox runtime tools registered');
  return ['mailbox.status', 'mailbox.list', 'mailbox.read', 'mailbox.ack'];
}
