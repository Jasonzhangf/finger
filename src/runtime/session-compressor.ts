/**
 * Session Compressor - 基于 Ledger 指针范围的压缩流程
 *
 * 设计原则：
 * 1. 压缩只取 ledger 指针范围内的数据，不扫描整个 ledger
 * 2. 压缩生成两个输出：消息摘要 + 用户偏好 patch
 * 3. 写入 compact-memory.jsonl（append-only）
 * 4. 更新 Session 指针
 */

import { promises as fs } from 'fs';
import { estimateTokens } from '../utils/token-counter.js';
import { getCompressTokenThreshold } from '../core/user-settings.js';
import {
  normalizeRootDir,
  resolveLedgerPath,
  resolveCompactMemoryPath,
  resolveBaseDir,
  readJsonLines,
} from './context-ledger-memory-helpers.js';
import type { Session } from '../orchestration/session-types.js';
import type { LedgerEntryFile, CompactMemoryEntryFile } from './context-ledger-memory-types.js';

export interface CompressOptions {
  /** Root dir override (defaults to session storage dir) */
  rootDir?: string;
  /** Agent ID for ledger path resolution */
  agentId?: string;
  /** Mode for ledger path resolution */
  mode?: string;
  /** Override compress threshold (reads from user-settings.json by default) */
  compressTokenThreshold?: number;
  /** Force compression (ignore threshold check, for manual compact) */
  force?: boolean;
  /**
   * External summarizer function.
   * When provided, called with ledger entries to produce summary + userPreferencePatch.
   * When omitted, uses a simple heuristic summarizer.
   */
  summarizer?: (entries: LedgerEntryFile[]) => Promise<CompressResult>;
}

export interface CompressResult {
  /** Standard content compression summary */
  summary: string;
  /** Extracted user preference changes */
  userPreferencePatch: string;
  /** Token count of the compressed block */
  tokenCount: number;
}

export interface CompressOutput {
  /** Whether compression was performed */
  compressed: boolean;
  /** Reason if not compressed */
  reason?: string;
  /** New latestCompactIndex (line in compact-memory.jsonl) */
  newCompactIndex: number;
  /** Updated session pointer values */
  pointers: {
    latestCompactIndex: number;
    originalStartIndex: number;
    originalEndIndex: number;
    totalTokens: number;
  };
  /** The compress result (if performed) */
  result?: CompressResult;
}

/**
 * Check if a session needs compression based on its totalTokens.
 */
export function needsCompression(session: Session, threshold?: number): boolean {
  const compressThreshold = threshold ?? getCompressTokenThreshold();
  return session.totalTokens > compressThreshold;
}

/**
 * Default heuristic summarizer (no LLM call).
 * Extracts user messages, assistant response count, and task IDs.
 */
async function defaultSummarizer(entries: LedgerEntryFile[]): Promise<CompressResult> {
  const userMessages: string[] = [];
  let assistantCount = 0;
  const taskIds = new Set<string>();

  for (const entry of entries) {
    const payload = entry.payload as Record<string, unknown>;
    if (entry.event_type === 'session_message') {
      const role = payload.role as string | undefined;
      const content = typeof payload.content === 'string' ? payload.content : '';
      if (role === 'user' && content.trim()) {
        userMessages.push(content.slice(0, 200));
      }
      if (role === 'assistant' || role === 'orchestrator') {
        assistantCount++;
      }
    }
    if (typeof payload.task_id === 'string') {
      taskIds.add(payload.task_id);
    }
  }

  const parts: string[] = [];
  if (userMessages.length > 0) {
    parts.push(`用户请求: ${userMessages.join('; ')}`);
  }
  if (assistantCount > 0) {
    parts.push(`助手响应: ${assistantCount} 条`);
  }
  if (taskIds.size > 0) {
    parts.push(`涉及任务: ${Array.from(taskIds).join(', ')}`);
  }

  const summary = parts.length > 0 ? parts.join('\n') : '无实质性内容';
  const fullText = summary;
  const tokenCount = estimateTokens(fullText);

  return {
    summary,
    userPreferencePatch: '',
    tokenCount,
  };
}

/**
 * Read ledger entries within a pointer range.
 * Returns only session_message entries in the [startIndex, endIndex] range.
 */
async function readLedgerRange(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
  startIndex: number,
  endIndex: number,
): Promise<LedgerEntryFile[]> {
  const ledgerPath = resolveLedgerPath(rootDir, sessionId, agentId, mode);
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);

  // Filter to session_message entries within the pointer range
  const messageEntries = allEntries.filter((entry) => {
    if (entry.event_type !== 'session_message') return false;
    // We can't truly index by line in JSONL since entries may vary.
    // Instead, we filter all session_message entries and slice by pointer range.
    return true;
  });

  // Slice by pointer range
  const start = Math.max(0, startIndex);
  const end = Math.min(messageEntries.length, endIndex + 1);
  return messageEntries.slice(start, end);
}

/**
 * Count total tokens from all session_message entries in the ledger.
 */
async function countLedgerTokens(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
): Promise<number> {
  const ledgerPath = resolveLedgerPath(rootDir, sessionId, agentId, mode);
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const messageEntries = allEntries.filter((e) => e.event_type === 'session_message');

  let total = 0;
  for (const entry of messageEntries) {
    const payload = entry.payload as Record<string, unknown>;
    const content = typeof payload.content === 'string' ? payload.content : '';
    const tc = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(content);
    total += tc;
  }
  return total;
}

/**
 * Compress a session based on its ledger pointer range.
 *
 * Steps:
 * 1. Check if compression is needed (totalTokens > threshold)
 * 2. Read ledger entries in pointer range
 * 3. Call summarizer (external LLM or default heuristic)
 * 4. Write compact block to compact-memory.jsonl
 * 5. Return updated pointer values
 */
export async function compressSession(
  session: Session,
  options: CompressOptions = {},
): Promise<CompressOutput> {
  const agentId = options.agentId || 'finger-system-agent';
  const mode = options.mode || 'main';
  const rootDir = options.rootDir || normalizeRootDir(undefined);
  const threshold = options.compressTokenThreshold ?? getCompressTokenThreshold();

  // Step 1: Check if compression is needed
  const force = options.force ?? false;
  // 只有非强制模式才检查 threshold（manual compact 强制压缩）
  if (!force && session.totalTokens <= threshold) {
    return {
      compressed: false,
      reason: `totalTokens (${session.totalTokens}) <= threshold (${threshold})`,
      newCompactIndex: session.latestCompactIndex,
      pointers: {
        latestCompactIndex: session.latestCompactIndex,
        originalStartIndex: session.originalStartIndex,
        originalEndIndex: session.originalEndIndex,
        totalTokens: session.totalTokens,
      },
    };
  }

  // Step 2: Read ledger entries in pointer range
  const entries = await readLedgerRange(
    rootDir, session.id, agentId, mode,
    session.originalStartIndex, session.originalEndIndex,
  );

  if (entries.length === 0) {
    return {
      compressed: false,
      reason: 'No session_message entries in pointer range',
      newCompactIndex: session.latestCompactIndex,
      pointers: {
        latestCompactIndex: session.latestCompactIndex,
        originalStartIndex: session.originalStartIndex,
        originalEndIndex: session.originalEndIndex,
        totalTokens: session.totalTokens,
      },
    };
  }

  // Step 3: Call summarizer
  const summarizerFn = options.summarizer || defaultSummarizer;
  const result = await summarizerFn(entries);

  // Step 4: Write compact block to compact-memory.jsonl
  const compactPath = resolveCompactMemoryPath(rootDir, session.id, agentId, mode);
  const baseDir = resolveBaseDir(rootDir, session.id, agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  const now = Date.now();
  const compactEntry = {
    id: `compact-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    session_id: session.id,
    agent_id: agentId,
    mode,
    event_type: 'compact_block',
    payload: {
      summary: result.summary,
      user_preference_patch: result.userPreferencePatch,
      source_range: {
        start: session.originalStartIndex,
        end: session.originalEndIndex,
      },
      entry_count: entries.length,
      token_count: result.tokenCount,
    },
  };

  // Read existing compact entries to determine new index
  const existingCompact = await readJsonLines<CompactMemoryEntryFile>(compactPath);
  const newCompactIndex = existingCompact.length; // 0-based index of the new entry

  try {
    await fs.appendFile(compactPath, `${JSON.stringify(compactEntry)}\n`, 'utf-8');
    console.log('[compressSession] ✅ Wrote compact_block to', compactPath);
  } catch (writeError) {
    console.error('[compressSession] ❌ Write compact_block failed:', writeError.message);
    throw writeError;
  }

  // Step 5: Calculate new pointers
  const newOriginalStartIndex = session.originalEndIndex + 1;

  // ✅ 读取 ledger 最新位置（压缩后 originalEndIndex 应更新为 ledger 最新行）
  const ledgerPath = resolveLedgerPath(rootDir, session.id, agentId, mode);
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const newOriginalEndIndex = allEntries.length - 1;  // ledger 最新位置

  // Count remaining tokens after compression
  const remainingEntries = await readLedgerRange(
    rootDir, session.id, agentId, mode,
    newOriginalStartIndex, newOriginalEndIndex,
  );
  let remainingTokens = result.tokenCount; // compact block tokens
  for (const entry of remainingEntries) {
    const payload = entry.payload as Record<string, unknown>;
    const tc = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(typeof payload.content === 'string' ? payload.content : '');
    remainingTokens += tc;
  }

  return {
    compressed: true,
    newCompactIndex,
    pointers: {
      latestCompactIndex: newCompactIndex,
      originalStartIndex: newOriginalStartIndex,
      originalEndIndex: newOriginalEndIndex,
      totalTokens: remainingTokens,
    },
    result,
  };
}

/**
 * Sync session's totalTokens from the actual ledger data.
 * Useful after initial migration or when pointers are stale.
 */
export async function syncSessionTokens(
  session: Session,
  options: { rootDir?: string; agentId?: string; mode?: string } = {},
): Promise<number> {
  const agentId = options.agentId || 'finger-system-agent';
  const mode = options.mode || 'main';
  const rootDir = options.rootDir || normalizeRootDir(undefined);

  const totalTokens = await countLedgerTokens(rootDir, session.id, agentId, mode);
  session.totalTokens = totalTokens;
  return totalTokens;
}
