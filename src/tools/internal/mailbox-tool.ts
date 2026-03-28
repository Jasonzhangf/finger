import type { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';
import { applyMailboxAckTransition, applyMailboxReadTransition } from '../../blocks/mailbox-block/protocol.js';
import {
  filterMailboxMessages,
  getMailboxPath,
  getShortDescription,
  messageIndex,
  normalizeIds,
  readMailboxMessages,
  resolveMailboxTarget,
  type ListOptions,
  type MailboxMessage,
  writeMailboxMessages,
} from './mailbox-tool-helpers.js';
export { mailboxRemoveTool, mailboxRemoveAllTool } from './mailbox-tool-remove.js';

const log = logger.module('MailboxTool');

/**
 * mailbox.status - Get mailbox overview (unread/pending counts)
 */
export const mailboxStatusTool: InternalTool = {
  name: 'mailbox.status',
  executionModel: 'state',
  description: 'Get mailbox status overview: count of unread and pending messages. Use this to check if there are new messages requiring attention.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target mailbox to check (default: current agent)',
      },
    },
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const target = resolveMailboxTarget(params as { target?: string }, context);
    
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    
    const unread = messages.filter(m => !m.readAt && m.status === 'pending');
    const pending = messages.filter(m => m.status === 'pending');
    const processing = messages.filter(m => m.status === 'processing');
    
    return {
      success: true,
      target,
      counts: {
        total: messages.length,
        unread: unread.length,
        pending: pending.length,
        processing: processing.length,
      },
      recentUnread: unread.slice(-5).map(m => ({
        id: m.id,
        seq: m.seq,
      sender: m.sender,
      category: m.category,
      priority: m.priority,
      shortDescription: getShortDescription(m, 80),
      createdAt: m.createdAt,
      })),
    };
  },
};

/**
 * mailbox.list - List messages in mailbox
 */
export const mailboxListTool: InternalTool = {
  name: 'mailbox.list',
  executionModel: 'state',
  description: 'List messages in mailbox with optional filters. Returns message summaries with id, status, sender, and short description.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target mailbox (default: current agent)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed'],
        description: 'Filter by message status',
      },
      category: {
        type: 'string',
        description: 'Filter by message category',
      },
      unreadOnly: {
        type: 'boolean',
        description: 'Only show unread messages',
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to return (default: 20)',
      },
    },
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const options = params as ListOptions & { target?: string };
    const { 
      status,
      category,
      unreadOnly,
      limit = 20,
    } = options;
    const target = resolveMailboxTarget(options, context);
    
    const mailboxPath = getMailboxPath(target);
    const messages = filterMailboxMessages(readMailboxMessages(mailboxPath), {
      status,
      category,
      unreadOnly,
      limit,
      ids: normalizeIds(options.ids),
    });
    
    const result = messages.slice(0, limit).map(m => ({
      id: m.id,
      seq: m.seq,
      status: m.status,
      sender: m.sender,
      channel: m.channel,
      category: m.category,
      priority: m.priority,
      shortDescription: getShortDescription(m, 100),
      readAt: m.readAt,
      ackAt: m.ackAt,
      createdAt: m.createdAt,
    }));
    
    return {
      success: true,
      target,
      count: result.length,
      total: messages.length,
      messages: result,
    };
  },
};

/**
 * mailbox.read_all - Batch read messages
 */
export const mailboxReadAllTool: InternalTool = {
  name: 'mailbox.read_all',
  executionModel: 'state',
  description: 'Read multiple mailbox messages. By default reads unread messages; normal tasks move pending → processing while notifications stay pending.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target mailbox (default: current agent)',
      },
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed'],
        description: 'Optional status filter before reading',
      },
      category: {
        type: 'string',
        description: 'Optional category filter before reading',
      },
      unreadOnly: {
        type: 'boolean',
        description: 'Only read unread messages (default: true)',
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to read',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit message ids to read',
      },
    },
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const options = params as ListOptions & { target?: string };
    const target = resolveMailboxTarget(options, context);
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    const selected = filterMailboxMessages(messages, {
      status: options.status,
      category: options.category,
      unreadOnly: options.unreadOnly !== false,
      limit: options.limit,
      ids: normalizeIds(options.ids),
    });

    let changed = 0;
    let movedToProcessing = 0;
    const updatedIds = new Set<string>();
    const updatedSummaries: Array<Record<string, unknown>> = [];

    for (const message of selected) {
      const transitioned = applyMailboxReadTransition(message);
      updatedSummaries.push({
        id: transitioned.message.id,
        status: transitioned.message.status,
        category: transitioned.message.category,
        priority: transitioned.message.priority,
        readAt: transitioned.message.readAt,
        ackAt: transitioned.message.ackAt,
      });
      if (!transitioned.changed) continue;
      changed += 1;
      if (transitioned.movedToProcessing) {
        movedToProcessing += 1;
      }
      updatedIds.add(message.id);
      const idx = messageIndex(messages, message.id);
      if (idx >= 0) {
        messages[idx] = transitioned.message;
      }
    }

    if (updatedIds.size > 0) {
      writeMailboxMessages(mailboxPath, messages);
    }

    return {
      success: true,
      target,
      matched: selected.length,
      changed,
      movedToProcessing,
      readIds: selected.map((message) => message.id),
      messages: updatedSummaries,
    };
  },
};

/**
 * mailbox.read - Read a specific message by ID
 */
export const mailboxReadTool: InternalTool = {
  name: 'mailbox.read',
  executionModel: 'state',
  description: 'Read a specific message by ID. First read will mark it as read and transition pending → processing.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Message ID to read',
      },
      target: {
        type: 'string',
        description: 'Target mailbox (default: current agent)',
      },
    },
    required: ['id'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { id } = params as { id: string; target?: string };
    const target = resolveMailboxTarget(params as { target?: string }, context);
    
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    const message = messages.find(m => m.id === id);
    
    if (!message) {
      return {
        success: false,
        error: `Message not found: ${id}`,
      };
    }
    
    const transitioned = applyMailboxReadTransition(message);

    if (transitioned.changed) {
      try {
        messages[messageIndex(messages, id)] = transitioned.message;
        writeMailboxMessages(mailboxPath, messages);
      } catch (error) {
        log.warn('[mailbox.read] Failed to mark as read', { id, error });
      }
    }

    return {
      success: true,
      target,
      handshake: {
        movedToProcessing: transitioned.movedToProcessing,
        requiresAck: transitioned.message.category !== 'notification' && !transitioned.message.ackAt,
      },
      message: {
        id: transitioned.message.id,
        seq: transitioned.message.seq,
        status: transitioned.message.status,
        sender: transitioned.message.sender,
        channel: transitioned.message.channel,
        content: transitioned.message.content,
        result: transitioned.message.result,
        error: transitioned.message.error,
        sessionId: transitioned.message.sessionId,
        threadId: transitioned.message.threadId,
        createdAt: transitioned.message.createdAt,
        readAt: transitioned.message.readAt,
        ackAt: transitioned.message.ackAt,
      },
    };
  },
};

/**
 * mailbox.ack - Acknowledge a message
 */
export const mailboxAckTool: InternalTool = {
  name: 'mailbox.ack',
  executionModel: 'state',
  description: 'Acknowledge a mailbox task after handling it. Requires mailbox.read(id) first and supports completed/failed terminal states.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Message ID to acknowledge',
      },
      target: {
        type: 'string',
        description: 'Target mailbox (default: current agent)',
      },
      status: {
        type: 'string',
        enum: ['completed', 'failed'],
        description: 'Terminal status to persist (default: completed, or failed when error is provided)',
      },
      result: {
        description: 'Structured result to store with the mailbox message',
      },
      error: {
        type: 'string',
        description: 'Failure reason when the task could not be completed',
      },
    },
    required: ['id'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { id, status, result, error } = params as {
      id: string;
      target?: string;
      status?: 'completed' | 'failed';
      result?: unknown;
      error?: string;
    };
    const target = resolveMailboxTarget(params as { target?: string }, context);
    
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    const idx = messageIndex(messages, id);
    
    if (idx === -1) {
      return {
        success: false,
        error: `Message not found: ${id}`,
      };
    }
    
    const message = messages[idx];
    const transitioned = applyMailboxAckTransition(message, {
      status,
      result,
      error,
    });
    if (!transitioned.ok || !transitioned.message) {
      return {
        success: false,
        error: transitioned.error ?? `Failed to acknowledge message: ${id}`,
      };
    }
    messages[idx] = transitioned.message;
    
    // Write back to mailbox
    try {
      writeMailboxMessages(mailboxPath, messages);
      
      log.info('[mailbox.ack] Message acknowledged', { id, target });
      
      return {
        success: true,
        target,
        status: transitioned.message.status,
        message: `Message ${id} acknowledged as ${transitioned.message.status}`,
        ackAt: transitioned.message.ackAt,
        result: transitioned.message.result,
        error: transitioned.message.error,
      };
   } catch (error) {
      log.error('[mailbox.ack] Failed to acknowledge', error instanceof Error ? error : new Error(String(error)));
     return {
        success: false,
        error: `Failed to acknowledge message: ${error}`,
      };
    }
  },
};
