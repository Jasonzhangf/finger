import type { LedgerEntryFile, CompactMemoryEntryFile } from './context-ledger-memory-types.js';
import { normalizeRootDir, readJsonLines, resolveCompactMemoryPath, resolveLedgerPath, resolveBaseDir } from './context-ledger-memory-helpers.js';
import { estimateTokens } from '../utils/token-counter.js';
import { promises as fs } from 'fs';

export interface LedgerReaderContext {
  rootDir?: string;
  sessionId: string;
  agentId: string;
  mode?: string;
}

export interface SessionViewMessage {
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  tokenCount: number;
  messageId?: string;
  timestamp?: string;
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

export async function buildSessionView(
  context: LedgerReaderContext,
  options: BuildSessionViewOptions = {},
): Promise<SessionView> {
  const mode = context.mode?.trim() || 'main';
  const rootDir = normalizeRootDir(context.rootDir);
  const ledgerPath = resolveLedgerPath(rootDir, context.sessionId, context.agentId, mode);
  const compactPath = resolveCompactMemoryPath(rootDir, context.sessionId, context.agentId, mode);

  // Ensure base directory exists for consistent path behavior
  await fs.mkdir(resolveBaseDir(rootDir, context.sessionId, context.agentId, mode), { recursive: true });

  const ledgerEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const messageEntries = ledgerEntries.filter((entry) => entry.event_type === 'session_message');

  const messages: SessionViewMessage[] = messageEntries.map((entry) => {
    const payload = entry.payload as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const role = (payload.role as SessionViewMessage['role']) || 'user';
    const tokenCount = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(content);
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    return {
      role,
      content,
      tokenCount,
      messageId,
      timestamp: entry.timestamp_iso,
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
