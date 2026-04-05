import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import type { AgentRuntimeDeps } from './types.js';
import { heartbeatMailbox, type HeartbeatMailboxMessage } from '../heartbeat-mailbox.js';
import {
  emitDispatchMailboxEvent,
  getShortDescription,
  normalizeMailboxMessage,
  resolveMailboxAckResult,
  resolveMailboxAckStatus,
  resolveMailboxTarget,
  type MailboxAckInput,
  type MailboxListInput,
  type MailboxRemoveInput,
  type MailboxReadAllInput,
  type MailboxRemoveAllInput,
  type MailboxToolContext,
} from './mailbox-shared.js';

const log = logger.module('AgentRuntimeMailbox');

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
    category: parsed.category,
    unreadOnly: parsed.unreadOnly,
    limit: typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
      ? Math.max(1, Math.floor(parsed.limit))
      : undefined,
  });
  // Preserve mailbox manager ordering (priority first, then recency) so runtime
  // worklist consumption keeps priority semantics.
  messages = [...messages];

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

async function handleMailboxReadAll(deps: AgentRuntimeDeps, input: unknown, context: MailboxToolContext): Promise<unknown> {
  const parsed = isObjectRecord(input) ? input as MailboxReadAllInput : {};
  const target = resolveMailboxTarget(parsed, context);
  const ids = Array.isArray(parsed.ids)
    ? parsed.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : undefined;

  const result = heartbeatMailbox.markReadAll(target, {
    status: parsed.status,
    category: parsed.category,
    unreadOnly: parsed.unreadOnly !== false,
    limit: typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
      ? Math.max(1, Math.floor(parsed.limit))
      : undefined,
    ...(ids && ids.length > 0 ? { ids } : {}),
  });

  for (const message of result.updatedMessages) {
    if (message.status !== 'processing') continue;
    await emitDispatchMailboxEvent(deps, message, 'processing', {
      result: {
        status: 'processing_mailbox',
        via: 'mailbox',
        mailboxMessageId: message.id,
      },
    });
  }

  return {
    success: true,
    target,
    matched: result.matched,
    changed: result.changed,
    movedToProcessing: result.movedToProcessing,
    readIds: result.updatedMessages.map((message) => message.id),
    messages: result.updatedMessages.map((message) => ({
      id: message.id,
      status: message.status,
      category: message.category,
      priority: message.priority,
      readAt: message.readAt,
      ackAt: message.ackAt,
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

  const parsed = input as unknown as MailboxAckInput;
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
    removed: ackResult.removed === true,
    message: normalizeMailboxMessage(updated),
  };
}

async function handleMailboxRemove(input: unknown, context: MailboxToolContext): Promise<unknown> {
  if (!isObjectRecord(input) || typeof input.id !== 'string' || input.id.trim().length === 0) {
    throw new Error('mailbox.remove id is required');
  }

  const parsed = input as unknown as MailboxRemoveInput;
  const target = resolveMailboxTarget(parsed, context);
  const id = parsed.id.trim();
  const result = heartbeatMailbox.remove(target, id);
  if (!result.removed) {
    return { success: false, error: `Message not found: ${id}` };
  }

  return {
    success: true,
    target,
    removed: true,
    removedId: result.removedId ?? id,
  };
}

async function handleMailboxRemoveAll(input: unknown, context: MailboxToolContext): Promise<unknown> {
  const parsed = isObjectRecord(input) ? input as MailboxRemoveAllInput : {};
  const target = resolveMailboxTarget(parsed, context);
  const ids = Array.isArray(parsed.ids)
    ? parsed.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map((id) => id.trim())
    : undefined;
  const result = heartbeatMailbox.removeAll(target, {
    status: parsed.status,
    category: parsed.category,
    unreadOnly: parsed.unreadOnly,
    limit: typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)
      ? Math.max(1, Math.floor(parsed.limit))
      : undefined,
    ...(ids && ids.length > 0 ? { ids } : {}),
  });

  return {
    success: true,
    target,
    matched: result.matched,
    removed: result.removed,
    removedIds: result.removedIds,
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
    name: 'mailbox.read_all',
    description: 'Read multiple mailbox messages at once. By default reads unread messages; task messages move pending → processing, notifications stay pending.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
        category: { type: 'string' },
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number' },
        ids: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxReadAll(deps, input, context ?? {}),
  });

  deps.runtime.registerTool({
    name: 'mailbox.ack',
    description: 'Finish a mailbox task after mailbox.read(id). Supports completed/failed and result/error payloads, then auto-cleans the message from ephemeral mailbox.',
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

  deps.runtime.registerTool({
    name: 'mailbox.remove',
    description: 'Remove one mailbox message by id after it is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        target: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxRemove(input, context ?? {}),
  });

  deps.runtime.registerTool({
    name: 'mailbox.remove_all',
    description: 'Remove multiple mailbox messages at once. Supports status/category/unread filters or explicit ids.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
        category: { type: 'string' },
        unreadOnly: { type: 'boolean' },
        limit: { type: 'number' },
        ids: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      additionalProperties: false,
    },
    handler: async (input: unknown, context?: Record<string, unknown>) => handleMailboxRemoveAll(input, context ?? {}),
  });

  log.info('Mailbox runtime tools registered');
  return ['mailbox.status', 'mailbox.list', 'mailbox.read', 'mailbox.read_all', 'mailbox.ack', 'mailbox.remove', 'mailbox.remove_all'];
}
