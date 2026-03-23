import type { InternalTool, ToolExecutionContext } from './types.js';
import { FINGER_HOME } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import * as fs from 'fs';
import * as path from 'path';

const log = logger.module('MailboxTool');

// Mailbox message structure (matches MailboxBlock)
interface MailboxMessage {
  id: string;
  seq: number;
  target: string;
  content: unknown;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  sender?: string;
  callbackId?: string;
  sessionId?: string;
  runtimeSessionId?: string;
  channel?: string;
  accountId?: string;
  threadId?: string;
  readAt?: string;
  ackAt?: string;
}

interface ListOptions {
  status?: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

// Helper to get mailbox path for a target
function getMailboxPath(target: string): string {
  return path.join(FINGER_HOME, 'mailbox', target, 'inbox.jsonl');
}

// Helper to read messages from a mailbox
function readMailboxMessages(mailboxPath: string): MailboxMessage[] {
  try {
    if (!fs.existsSync(mailboxPath)) {
      return [];
    }
    const content = fs.readFileSync(mailboxPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as MailboxMessage);
  } catch (error) {
    log.warn('[readMailboxMessages] Failed to read mailbox', { mailboxPath, error });
    return [];
  }
}

// Helper to get short description for a message
function getShortDescription(message: MailboxMessage, maxLength = 100): string {
  let desc = '';
  if (typeof message.content === 'string') {
    desc = message.content;
  } else if (message.content && typeof message.content === 'object') {
    const content = message.content as Record<string, unknown>;
    desc = (content.text as string) || (content.summary as string) || JSON.stringify(content);
  } else {
    desc = JSON.stringify(message.content);
  }
  return desc.length > maxLength ? desc.substring(0, maxLength) + '...' : desc;
}

/**
 * mailbox.status - Get mailbox overview (unread/pending counts)
 */
export const mailboxStatusTool: InternalTool = {
  name: 'mailbox.status',
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
    const { target = context.sessionId ? `agent-${context.sessionId}` : 'finger-system-agent' } = params as { target?: string };
    
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
      target = context.sessionId ? `agent-${context.sessionId}` : 'finger-system-agent',
      status,
      unreadOnly,
      limit = 20,
    } = options;
    
    const mailboxPath = getMailboxPath(target);
    let messages = readMailboxMessages(mailboxPath);
    
    if (status) {
      messages = messages.filter(m => m.status === status);
    }
    if (unreadOnly) {
      messages = messages.filter(m => !m.readAt);
    }
    
    // Sort by seq descending (newest first)
    messages.sort((a, b) => b.seq - a.seq);
    
    const result = messages.slice(0, limit).map(m => ({
      id: m.id,
      seq: m.seq,
      status: m.status,
      sender: m.sender,
      channel: m.channel,
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
 * mailbox.read - Read a specific message by ID
 */
export const mailboxReadTool: InternalTool = {
  name: 'mailbox.read',
  description: 'Read a specific message by ID. Returns full message content and marks as read.',
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
    const { id, target = context.sessionId ? `agent-${context.sessionId}` : 'finger-system-agent' } = params as { id: string; target?: string };
    
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    const message = messages.find(m => m.id === id);
    
    if (!message) {
      return {
        success: false,
        error: `Message not found: ${id}`,
      };
    }
    
    // Mark as read (update readAt timestamp)
    if (!message.readAt) {
      message.readAt = new Date().toISOString();
      // Write back to mailbox
      try {
        const updatedLines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
        fs.writeFileSync(mailboxPath, updatedLines, 'utf-8');
      } catch (error) {
        log.warn('[mailbox.read] Failed to mark as read', { id, error });
      }
    }
    
    return {
      success: true,
      message: {
        id: message.id,
        seq: message.seq,
        status: message.status,
        sender: message.sender,
        channel: message.channel,
        content: message.content,
        result: message.result,
        error: message.error,
        sessionId: message.sessionId,
        threadId: message.threadId,
        createdAt: message.createdAt,
        readAt: message.readAt,
        ackAt: message.ackAt,
      },
    };
  },
};

/**
 * mailbox.ack - Acknowledge a message
 */
export const mailboxAckTool: InternalTool = {
  name: 'mailbox.ack',
  description: 'Acknowledge a message, marking it as processed. Use after handling the message.',
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
    },
    required: ['id'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { id, target = context.sessionId ? `agent-${context.sessionId}` : 'finger-system-agent' } = params as { id: string; target?: string };
    
    const mailboxPath = getMailboxPath(target);
    const messages = readMailboxMessages(mailboxPath);
    const messageIndex = messages.findIndex(m => m.id === id);
    
    if (messageIndex === -1) {
      return {
        success: false,
        error: `Message not found: ${id}`,
      };
    }
    
    const message = messages[messageIndex];
    message.ackAt = new Date().toISOString();
    message.status = 'completed';
    
    // Write back to mailbox
    try {
      const updatedLines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
      fs.writeFileSync(mailboxPath, updatedLines, 'utf-8');
      
      log.info('[mailbox.ack] Message acknowledged', { id, target });
      
      return {
        success: true,
        message: `Message ${id} acknowledged`,
        ackAt: message.ackAt,
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
