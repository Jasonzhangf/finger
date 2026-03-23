import type { InternalTool, ToolExecutionContext } from './types.js';
import {
  filterMailboxMessages,
  getMailboxPath,
  messageIndex,
  normalizeIds,
  readMailboxMessages,
  resolveMailboxTarget,
  type ListOptions,
  writeMailboxMessages,
} from './mailbox-tool-helpers.js';

/**
 * mailbox.remove - Remove a single message
 */
export const mailboxRemoveTool: InternalTool = {
  name: 'mailbox.remove',
  description: 'Remove one mailbox message by id after it is no longer needed.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Message ID to remove',
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
    const idx = messageIndex(messages, id);

    if (idx === -1) {
      return {
        success: false,
        error: `Message not found: ${id}`,
      };
    }

    const [removed] = messages.splice(idx, 1);
    writeMailboxMessages(mailboxPath, messages);

    return {
      success: true,
      target,
      removed: true,
      removedId: removed?.id ?? id,
    };
  },
};

/**
 * mailbox.remove_all - Remove messages in bulk
 */
export const mailboxRemoveAllTool: InternalTool = {
  name: 'mailbox.remove_all',
  description: 'Remove mailbox messages in bulk. Supports status/category/unread filters or explicit ids.',
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
        description: 'Optional status filter before removal',
      },
      category: {
        type: 'string',
        description: 'Optional category filter before removal',
      },
      unreadOnly: {
        type: 'boolean',
        description: 'Only remove unread messages',
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to remove',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit message ids to remove',
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
      unreadOnly: options.unreadOnly,
      limit: options.limit,
      ids: normalizeIds(options.ids),
    });

    if (selected.length === 0) {
      return {
        success: true,
        target,
        matched: 0,
        removed: 0,
        removedIds: [],
      };
    }

    const removedIds = new Set(selected.map((message) => message.id));
    const remaining = messages.filter((message) => !removedIds.has(message.id));
    writeMailboxMessages(mailboxPath, remaining);

    return {
      success: true,
      target,
      matched: selected.length,
      removed: removedIds.size,
      removedIds: Array.from(removedIds),
    };
  },
};
