import { FINGER_HOME } from '../../core/finger-paths.js';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolExecutionContext } from './types.js';

export interface MailboxMessage {
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
  sourceType?: 'control' | 'observe' | 'agent-callable';
  category?: string;
  priority?: 0 | 1 | 2 | 3;
  deliveryPolicy?: 'realtime' | 'batched' | 'passive';
  readAt?: string;
  ackAt?: string;
}

export interface ListOptions {
  status?: string;
  category?: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  ids?: string[];
}

export function resolveMailboxTarget(
  params: { target?: string },
  context: ToolExecutionContext,
): string {
  const explicitTarget = typeof params.target === 'string' ? params.target.trim() : '';
  if (explicitTarget.length > 0) return explicitTarget;
  const agentTarget = typeof context.agentId === 'string' ? context.agentId.trim() : '';
  if (agentTarget.length > 0) return agentTarget;
  return 'finger-system-agent';
}

export function getMailboxPath(target: string): string {
  return path.join(FINGER_HOME, 'mailbox', target, 'inbox.jsonl');
}

export function readMailboxMessages(mailboxPath: string): MailboxMessage[] {
  try {
    if (!fs.existsSync(mailboxPath)) {
      return [];
    }
    const content = fs.readFileSync(mailboxPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map(line => JSON.parse(line) as MailboxMessage);
  } catch {
    return [];
  }
}

export function writeMailboxMessages(mailboxPath: string, messages: MailboxMessage[]): void {
  const dir = path.dirname(mailboxPath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = messages.length > 0
    ? messages.map((message) => JSON.stringify(message)).join('\n') + '\n'
    : '';
  fs.writeFileSync(mailboxPath, payload, 'utf-8');
}

export function filterMailboxMessages(messages: MailboxMessage[], options: ListOptions): MailboxMessage[] {
  let filtered = [...messages];

  if (options.status) {
    filtered = filtered.filter((message) => message.status === options.status);
  }
  if (options.category) {
    filtered = filtered.filter((message) => message.category === options.category);
  }
  if (options.unreadOnly) {
    filtered = filtered.filter((message) => !message.readAt);
  }
  if (Array.isArray(options.ids) && options.ids.length > 0) {
    const allowedIds = new Set(options.ids);
    filtered = filtered.filter((message) => allowedIds.has(message.id));
  }

  filtered.sort((a, b) => b.seq - a.seq);

  if (typeof options.offset === 'number' && Number.isFinite(options.offset) && options.offset > 0) {
    filtered = filtered.slice(Math.floor(options.offset));
  }
  if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
    filtered = filtered.slice(0, Math.floor(options.limit));
  }

  return filtered;
}

export function normalizeIds(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const normalized = ids
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
  return normalized.length > 0 ? normalized : undefined;
}

export function getShortDescription(message: MailboxMessage, maxLength = 100): string {
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

export function messageIndex(messages: MailboxMessage[], id: string): number {
  return messages.findIndex(m => m.id === id);
}
