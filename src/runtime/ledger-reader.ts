import type { LedgerEntryFile, CompactMemoryEntryFile } from './context-ledger-memory-types.js';
import { normalizeRootDir, normalizeRootDirForAgent, readJsonLines, resolveCompactMemoryPath, resolveLedgerPath, resolveBaseDir } from './context-ledger-memory-helpers.js';
import { estimateTokens } from '../utils/token-counter.js';
import { promises as fs } from 'fs';

/** Compact placeholder for attachments in history messages */
export interface AttachmentPlaceholder {
  /** How many attachments were in the original message */
  count: number;
  /** Types summary, e.g. "2 images, 1 file" */
  summary: string;
}

export type SessionAttachment = AttachmentPlaceholder | import('../bridges/types.js').ChannelAttachment[];

export interface LedgerReaderContext {
  rootDir?: string;
  sessionId: string;
  agentId: string;
  mode?: string;
}

export interface SessionViewMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount: number;
  messageId?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  /**
   * Attachments for this message.
   * - Last message (current turn): full ChannelAttachment[] with urls and metadata.
   * - History messages: compact placeholder { count, summary }.
   */
  attachments?: SessionAttachment;
}

export interface SessionView {
  compressedSummary?: string;
  compressedSummaryTokens?: number;
  messages: SessionViewMessage[];
  tokenCount: number;
  source: {
    ledgerPath: string;
    compactPath: string;
  };
}

export interface BuildSessionViewOptions {
  maxTokens?: number;
  includeSummary?: boolean;
}

/**
 * Build a compact placeholder from raw attachments.
 * History messages use this to avoid re-sending full attachment data every turn.
 */
function compactAttachments(raw: unknown): AttachmentPlaceholder | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const typeCounts: Record<string, number> = {};
  for (const item of raw) {
    if (item && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string') {
      const type = (item as { type: string }).type;
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
  }
  const parts = Object.entries(typeCounts).map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`);
  return {
    count: raw.length,
    summary: parts.join(', ') || `${raw.length} attachment(s)`,
  };
}

/**
 * Check if an attachment item is a placeholder (not a full attachment).
 */
export function isAttachmentPlaceholder(att: SessionAttachment): att is AttachmentPlaceholder {
  return att != null && typeof att === 'object' && !Array.isArray(att) && 'count' in att && 'summary' in att;
}

export async function buildSessionView(
  context: LedgerReaderContext,
  options: BuildSessionViewOptions = {},
): Promise<SessionView> {
  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDirForAgent(context.rootDir, context.agentId);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);
  const compactPath = resolveCompactMemoryPath(rootDir, context.sessionId, context.agentId, mode);

  // Ensure base directory exists for consistent path behavior
  await fs.mkdir(resolveBaseDir(rootDir, context.sessionId, context.agentId, mode), { recursive: true });

  const ledgerEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const messageEntries = ledgerEntries.filter((entry) => entry.event_type === 'session_message');
  const lastMessageEntryIdx = messageEntries.length - 1;

  const messages: SessionViewMessage[] = messageEntries.map((entry, idx) => {
    const payload = entry.payload as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const role = (payload.role as SessionViewMessage['role']) || 'user';
    const tokenCount = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(content);
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata as Record<string, unknown>
      : undefined;
    const rawAttachments = payload.attachments;
    let attachments: SessionAttachment | undefined;
    if (Array.isArray(rawAttachments) && rawAttachments.length > 0) {
      // Current turn (last message): preserve full attachment data.
      // History turns: use compact placeholder to avoid repeated large payload in context.
      attachments = idx === lastMessageEntryIdx
        ? rawAttachments as import('../bridges/types.js').ChannelAttachment[]
        : compactAttachments(rawAttachments);
    }
    return {
      role,
      content,
      tokenCount,
      messageId,
      timestamp: entry.timestamp_iso,
      metadata,
      attachments,
    };
  });

  let compressedSummary: string | undefined;
  let compressedSummaryTokens: number | undefined;
  if (options.includeSummary !== false) {
    const compactEntries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
    const matched = compactEntries.filter((entry) => entry.session_id === context.sessionId && entry.agent_id === context.agentId && entry.mode === mode);
    const latest = matched.length > 0 ? matched[matched.length - 1] : undefined;
    const summary = latest && typeof latest.payload?.summary === 'string' ? latest.payload.summary : undefined;
    if (summary) {
      compressedSummary = summary;
      compressedSummaryTokens = estimateTokens(summary);
    }
  }

  if (!Number.isFinite(options.maxTokens) || (options.maxTokens ?? 0) <= 0) {
    const total = messages.reduce((sum, msg) => sum + msg.tokenCount, 0) + (compressedSummaryTokens ?? 0);
    return {
      compressedSummary,
      compressedSummaryTokens,
      messages,
      tokenCount: total,
      source: { ledgerPath, compactPath },
    };
  }

  const maxTokens = Math.floor(options.maxTokens!);
  let budget = Math.max(0, maxTokens - (compressedSummaryTokens ?? 0));

  const selected: SessionViewMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (selected.length === 0) {
      selected.push(msg);
      budget -= msg.tokenCount;
      continue;
    }
    if (budget - msg.tokenCount >= 0) {
      selected.push(msg);
      budget -= msg.tokenCount;
    } else {
      break;
    }
  }

  selected.reverse();
  const total = selected.reduce((sum, msg) => sum + msg.tokenCount, 0) + (compressedSummaryTokens ?? 0);

  return {
    compressedSummary,
    compressedSummaryTokens,
    messages: selected,
    tokenCount: total,
    source: { ledgerPath, compactPath },
  };
}
