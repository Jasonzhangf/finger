import { promises as fs } from 'fs';
import type { Attachment } from './events.js';
import { estimateTokens } from '../utils/token-counter.js';
import { normalizeRootDir, resolveLedgerPath, resolveBaseDir, appendLedgerEvent } from './context-ledger-memory-helpers.js';

export interface LedgerWriterContext {
  rootDir?: string;
  sessionId: string;
  agentId: string;
  mode?: string;
}

export interface LedgerMessageInput {
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  messageId?: string;
  tokenCount?: number;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export async function appendSessionMessage(context: LedgerWriterContext, message: LedgerMessageInput): Promise<void> {
  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDir(context.rootDir);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);

  // Ensure ledger directory exists
  const baseDir = resolveBaseDir(rootDir, context.sessionId, context.agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  const tokenCount = typeof message.tokenCount === 'number' && Number.isFinite(message.tokenCount)
    ? Math.max(0, Math.floor(message.tokenCount))
    : estimateTokens(message.content);

  await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.agentId,
    mode,
    event_type: 'session_message',
    payload: {
      role: message.role,
      content: message.content,
      token_count: tokenCount,
      message_id: message.messageId,
      attachments: message.attachments,
      metadata: message.metadata,
    },
  });
}

export async function appendLedgerEventEntry(
  context: LedgerWriterContext,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDir(context.rootDir);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);
  const baseDir = resolveBaseDir(rootDir, context.sessionId, context.agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.agentId,
    mode,
    event_type: eventType,
    payload,
  });
}
