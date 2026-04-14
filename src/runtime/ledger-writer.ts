import { promises as fs } from 'fs';
import type { Attachment } from '../bridges/types.js';
import { estimateTokens } from '../utils/token-counter.js';
import { normalizeRootDir, normalizeRootDirForAgent, resolveLedgerPath, resolveBaseDir, appendLedgerEvent } from './context-ledger-memory-helpers.js';

export interface LedgerWriterContext {
  rootDir?: string;
  sessionId: string;
  agentId: string;
  mode?: string;
  sessionTier?: string;  // 'heartbeat' | 'heartbeat-control' → skip ledger
  skipLedger?: boolean;  // explicitly skip ledger write
  track?: string;         // Multi-track: which track this entry belongs to
}

export interface LedgerMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageId?: string;
  tokenCount?: number;
  attachments?: Attachment[];
  metadata?: Record<string, unknown>;
}

export async function appendSessionMessage(context: LedgerWriterContext, message: LedgerMessageInput): Promise<{ slotNumber: number } | void> {
  // Skip ledger write for heartbeat sessions (per design doc section 3.1)
  const sessionTier = context.sessionTier?.trim().toLowerCase() || '';
  if (context.skipLedger === true
      || sessionTier === 'heartbeat'
      || sessionTier === 'heartbeat-control') {
    return; // Heartbeat sessions do NOT write ledger
  }

  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDirForAgent(context.rootDir, context.agentId);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);

  // Ensure ledger directory exists
  const baseDir = resolveBaseDir(rootDir, context.sessionId, context.agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  const tokenCount = typeof message.tokenCount === 'number' && Number.isFinite(message.tokenCount)
    ? Math.max(0, Math.floor(message.tokenCount))
    : estimateTokens(message.content);

  return await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.agentId,
    mode,
    track: context.track,
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
): Promise<{ slotNumber: number } | void> {
  // Skip ledger write for heartbeat sessions (per design doc section 3.1)
  const sessionTier = context.sessionTier?.trim().toLowerCase() || '';
  if (context.skipLedger === true
      || sessionTier === 'heartbeat'
      || sessionTier === 'heartbeat-control') {
    return; // Heartbeat sessions do NOT write ledger
  }

  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDirForAgent(context.rootDir, context.agentId);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);
  const baseDir = resolveBaseDir(rootDir, context.sessionId, context.agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  return await appendLedgerEvent(ledgerPath, {
    session_id: context.sessionId,
    agent_id: context.agentId,
    mode,
    track: context.track,
    event_type: eventType,
    payload,
  });
}
