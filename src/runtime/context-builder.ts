/**
 * Context Builder - 动态上下文构建器
 *
 * 职责：
 * 1. 读取 MEMORY.md 作为强制性长期记忆上下文
 * 2. 从运行时 session 快照或 Ledger 读取历史记录（默认优先 session 快照）
 * 3. 任务边界分组（一次完整用户请求 = 一个 task）
 * 4. 模型辅助排序（可选）
 * 5. 预算控制组装上下文
 *
 * 设计原则：
 * - Ledger 是存储真源（append-only timeline）
 * - 运行时默认消费 session 视图，不直接消费 raw ledger 回放
 * - 截断/重组只发生在构建 session 视图时
 * - MEMORY.md 是强制上下文
 */

import * as fs from 'fs';
import * as path from 'path';
import { estimateTokens } from '../utils/token-counter.js';
import { getContextWindow } from '../core/user-settings.js';
import {
  resolveKernelProvider,
  buildProviderHeaders,
  buildResponsesEndpoints,
} from '../core/kernel-provider-client.js';
import {
  buildPreview,
  readJsonLines,
  normalizeRootDir,
  resolveLedgerPath,
  resolveCompactMemoryPath,
} from './context-ledger-memory-helpers.js';
import { executeContextLedgerMemory } from './context-ledger-memory.js';
import { logger } from '../core/logger.js';
import type {
  LedgerEntryFile,
  CompactMemoryEntryFile,
} from './context-ledger-memory-types.js';
import type {
  ContextMessageZone,
  TaskBlock,
  TaskMessage,
  ContextBuildOptions,
  ContextBuildResult,
  RankingOutput,
  ContextBuildMode,
} from './context-builder-types.js';
import { runTaskEmbeddingRecall } from './context-builder-embedding-recall.js';

type AttachmentPlaceholder = {
  count: number;
  summary: string;
};

interface SessionSnapshotMessage {
  id?: string;
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
}

interface CompactReplacementHistoryItem {
  id?: string;
  task_id?: string;
  start_time_iso?: string;
  end_time_iso?: string;
  request?: string;
  summary?: string;
  key_tools?: string[];
  key_reads?: string[];
  key_writes?: string[];
  tool_calls?: Array<{
    tool?: string;
    input?: string;
    status?: string;
    output?: string;
  }>;
  topic?: string;
  tags?: string[];
}

interface DigestCoverageCheckResult {
  checked: boolean;
  ledgerSlots: number;
  compactEntries: number;
  maxCompactedSlot: number;
  missingSlots: number;
  backfilled: boolean;
  taskDigestCount?: number;
  note?: string;
  error?: string;
}

// ── 常量 ──────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_RATIO = 0.85; // 目标上下文占模型窗口的比例
const DEFAULT_SYSTEM_ONLY_TASK_GAP_MS = 3 * 60 * 1000; // 无 user 边界时，超过 3 分钟按新任务分段
const log = logger.module('ContextBuilder');

function normalizeTaskMessageRole(input: unknown): TaskMessage['role'] {
  if (input === 'assistant' || input === 'system' || input === 'orchestrator' || input === 'user') {
    return input;
  }
  return 'user';
}

function safeParseIsoToMs(iso?: string, fallback = Date.now()): number {
  if (!iso || typeof iso !== 'string') return fallback;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringArray(input: unknown, maxItems = 8): string[] {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item, index, arr) => arr.indexOf(item) === index);
  return normalized.slice(0, Math.max(1, maxItems));
}

function buildCompactDigestContent(item: CompactReplacementHistoryItem): string {
  const request = typeof item.request === 'string' ? item.request.trim() : '';
  const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
  const keyTools = normalizeStringArray(item.key_tools, 12);
  const keyReads = normalizeStringArray(item.key_reads, 8);
  const keyWrites = normalizeStringArray(item.key_writes, 8);
  const toolCalls = Array.isArray(item.tool_calls)
    ? item.tool_calls
      .filter((call): call is { tool?: string; input?: string; status?: string; output?: string } =>
        typeof call === 'object' && call !== null && !Array.isArray(call))
      .map((call) => ({
        tool: typeof call.tool === 'string' ? call.tool.trim() : '',
        input: typeof call.input === 'string' ? call.input.trim() : '',
        status: typeof call.status === 'string' ? call.status.trim().toLowerCase() : 'unknown',
        output: typeof call.output === 'string' ? call.output.trim() : '',
      }))
      .filter((call) => call.tool.length > 0)
    : [];
  const lines: string[] = [];
  if (request) lines.push(`请求: ${request}`);
  if (summary) lines.push(`结果: ${summary}`);
  if (keyTools.length > 0) lines.push(`工具: ${keyTools.join(', ')}`);
  if (toolCalls.length > 0) {
    lines.push('工具调用:');
    for (const call of toolCalls) {
      const status = call.status === 'success'
        ? 'success'
        : call.status === 'failure'
          ? 'failure'
          : 'unknown';
      const argsPart = call.input ? ` args=${buildPreview(call.input, 220)}` : '';
      lines.push(`- ${call.tool}${argsPart} -> ${status}`);
      if (call.output) {
        lines.push(`  output=${call.output}`);
      }
    }
  }
  if (keyReads.length > 0) lines.push(`读取: ${keyReads.join(', ')}`);
  if (keyWrites.length > 0) lines.push(`写入: ${keyWrites.join(', ')}`);
  if (lines.length === 0) return '(compact task digest)';
  return lines.join('\n');
}

function buildTaskBlockFromCompactDigest(
  item: CompactReplacementHistoryItem,
  fallbackTs: number,
): TaskBlock | null {
  const content = buildCompactDigestContent(item).trim();
  if (!content) return null;
  const startTs = safeParseIsoToMs(item.start_time_iso, fallbackTs);
  const endTs = safeParseIsoToMs(item.end_time_iso, Math.max(startTs, fallbackTs));
  const digestMessageId = typeof item.id === 'string' && item.id.trim().length > 0
    ? item.id.trim()
    : typeof item.task_id === 'string' && item.task_id.trim().length > 0
      ? item.task_id.trim()
      : `compact-${startTs}`;
  const tags = normalizeStringArray(item.tags, 12);
  const topic = typeof item.topic === 'string' && item.topic.trim().length > 0 ? item.topic.trim() : undefined;
  const digestMessage: TaskMessage = {
    id: `compact-msg-${digestMessageId}`,
    role: 'assistant',
    content,
    timestamp: endTs,
    timestampIso: new Date(endTs).toISOString(),
    tokenCount: estimateTokens(content),
    messageId: digestMessageId,
    metadata: {
      compactDigest: true,
      digestId: digestMessageId,
      ...(typeof item.task_id === 'string' && item.task_id.trim().length > 0 ? { taskId: item.task_id.trim() } : {}),
      ...(topic ? { topic } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
  return finalizeBlock(
    `compact-task-${digestMessageId}`,
    startTs,
    [digestMessage],
  );
}

async function loadCompactReplacementHistoryBlocks(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
): Promise<TaskBlock[]> {
  const compactPath = resolveCompactMemoryPath(rootDir, sessionId, agentId, mode);
  const compactEntries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
  if (compactEntries.length === 0) return [];
  const latest = compactEntries[compactEntries.length - 1];
  const payload = latest?.payload && typeof latest.payload === 'object'
    ? latest.payload as Record<string, unknown>
    : undefined;
  if (!payload) return [];
  const rawHistory = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
  if (rawHistory.length === 0) return [];
  const fallbackTs = typeof latest.timestamp_ms === 'number' && Number.isFinite(latest.timestamp_ms)
    ? latest.timestamp_ms
    : Date.now();
  const blocks = rawHistory
    .filter((item): item is CompactReplacementHistoryItem => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item, index) => buildTaskBlockFromCompactDigest(item, fallbackTs + index))
    .filter((item): item is TaskBlock => !!item);
  return blocks;
}

function readCompactSourceSlotEnd(entry: CompactMemoryEntryFile): number {
  const payload = entry?.payload && typeof entry.payload === 'object'
    ? entry.payload as Record<string, unknown>
    : {};
  const sourceSlotEnd = payload.source_slot_end;
  if (typeof sourceSlotEnd === 'number' && Number.isFinite(sourceSlotEnd) && sourceSlotEnd > 0) {
    return Math.floor(sourceSlotEnd);
  }
  return 0;
}

async function ensureCompactDigestCoverage(params: {
  rootDir: string;
  sessionId: string;
  agentId: string;
  mode: string;
}): Promise<DigestCoverageCheckResult> {
  const ledgerPath = resolveLedgerPath(params.rootDir, params.sessionId, params.agentId, params.mode);
  const compactPath = resolveCompactMemoryPath(params.rootDir, params.sessionId, params.agentId, params.mode);
  const fullLedgerEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const ledgerSlots = fullLedgerEntries.filter((entry) => entry.event_type !== 'context_compact').length;
  const compactEntries = await readJsonLines<CompactMemoryEntryFile>(compactPath);
  const maxCompactedSlot = compactEntries.reduce((max, entry) => Math.max(max, readCompactSourceSlotEnd(entry)), 0);
  const missingSlots = Math.max(0, ledgerSlots - maxCompactedSlot);
  if (ledgerSlots <= 0) {
    return {
      checked: true,
      ledgerSlots,
      compactEntries: compactEntries.length,
      maxCompactedSlot,
      missingSlots,
      backfilled: false,
      note: 'ledger_empty',
    };
  }
  if (missingSlots <= 0 && compactEntries.length > 0) {
    return {
      checked: true,
      ledgerSlots,
      compactEntries: compactEntries.length,
      maxCompactedSlot,
      missingSlots: 0,
      backfilled: false,
      note: 'already_covered',
    };
  }
  try {
    const result = await executeContextLedgerMemory({
      action: 'digest_backfill',
      _runtime_context: {
        root_dir: params.rootDir,
        session_id: params.sessionId,
        agent_id: params.agentId,
        mode: params.mode,
      },
    });
    return {
      checked: true,
      ledgerSlots,
      compactEntries: compactEntries.length,
      maxCompactedSlot,
      missingSlots,
      backfilled: true,
      ...(result.action === 'digest_backfill' && typeof result.task_digest_count === 'number'
        ? { taskDigestCount: Math.max(0, Math.floor(result.task_digest_count)) }
        : {}),
      note: result.action === 'digest_backfill' && typeof result.note === 'string' ? result.note : 'backfilled',
    };
  } catch (error) {
    return {
      checked: true,
      ledgerSlots,
      compactEntries: compactEntries.length,
      maxCompactedSlot,
      missingSlots,
      backfilled: false,
      note: 'backfill_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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

function extractDispatchId(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const candidates = [metadata.dispatchId, metadata.dispatch_id, metadata.dispatch_id_v2];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim().length > 0) {
      return item.trim();
    }
  }
  return undefined;
}

function isReasoningStopBoundary(message: TaskMessage): boolean {
  const metadata = message.metadata;
  if (metadata && typeof metadata === 'object') {
    const directTool = typeof metadata.toolName === 'string'
      ? metadata.toolName.trim()
      : (typeof metadata.tool === 'string' ? metadata.tool.trim() : '');
    if (directTool === 'reasoning.stop') return true;
    const event = metadata.event;
    if (event && typeof event === 'object') {
      const eventTool = typeof (event as Record<string, unknown>).toolName === 'string'
        ? ((event as Record<string, unknown>).toolName as string).trim()
        : (typeof (event as Record<string, unknown>).tool === 'string'
          ? ((event as Record<string, unknown>).tool as string).trim()
          : '');
      if (eventTool === 'reasoning.stop') return true;
    }
  }
  const content = typeof message.content === 'string' ? message.content : '';
  if (!content) return false;
  return /\breasoning\.stop\b/i.test(content);
}

function groupWithoutUserBoundary(messages: TaskMessage[]): TaskBlock[] {
  if (messages.length === 0) return [];
  const blocks: TaskBlock[] = [];
  let currentBlock: TaskMessage[] = [];
  let blockStartTs = 0;
  let blockId = '';
  let currentDispatchId: string | undefined;
  let previousTs = 0;

  const flush = () => {
    if (currentBlock.length === 0) return;
    blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
    currentBlock = [];
    currentDispatchId = undefined;
  };

  for (const message of messages) {
    if (currentBlock.length === 0) {
      blockStartTs = message.timestamp;
      blockId = `task-${message.timestamp}`;
      previousTs = message.timestamp;
    }
    const dispatchId = extractDispatchId(message.metadata);
    const gapMs = Math.max(0, message.timestamp - previousTs);
    const dispatchChanged = !!dispatchId && !!currentDispatchId && dispatchId !== currentDispatchId;
    const gapBoundary = gapMs > DEFAULT_SYSTEM_ONLY_TASK_GAP_MS;

    if (currentBlock.length > 0 && (dispatchChanged || gapBoundary)) {
      flush();
      blockStartTs = message.timestamp;
      blockId = `task-${message.timestamp}`;
    }

    currentBlock.push(message);
    if (!currentDispatchId && dispatchId) currentDispatchId = dispatchId;
    if (isReasoningStopBoundary(message)) {
      flush();
      continue;
    }
    previousTs = message.timestamp;
  }

  flush();
  return blocks;
}

// ── 工具函数 ──────────────────────────────────────────────────────────

/**
 * 按任务边界分组 ledger 条目
 * 任务 = 从一个 user 消息开始，到下一个 user 消息之前的所有消息
 * 最后一个任务块包含到最新记录
 */
function groupByTaskBoundary(entries: LedgerEntryFile[]): TaskBlock[] {
  if (entries.length === 0) return [];

  const orderedEntries = [...entries].sort((a, b) => {
    if (a.timestamp_ms !== b.timestamp_ms) return a.timestamp_ms - b.timestamp_ms;
    return String(a.id).localeCompare(String(b.id));
  });

  const messages: TaskMessage[] = [];
  for (const entry of orderedEntries) {
    const payload = entry.payload as Record<string, unknown>;
    const role = normalizeTaskMessageRole(payload.role);
    const content = typeof payload.content === 'string' ? payload.content : '';
    const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata as Record<string, unknown>
      : undefined;
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    const attachments = compactAttachments(payload.attachments);
    const tokenCount = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(content);

    messages.push({
      id: entry.id,
      role,
      content,
      timestamp: entry.timestamp_ms,
      timestampIso: entry.timestamp_iso,
      tokenCount,
      messageId,
      metadata,
      attachments,
    });
  }

  const hasUserBoundary = messages.some((message) => message.role === 'user');
  if (!hasUserBoundary) {
    return groupWithoutUserBoundary(messages);
  }

  const blocks: TaskBlock[] = [];
  let currentBlock: TaskMessage[] = [];
  let blockStartTs = 0;
  let blockId = '';

  for (const msg of messages) {
    if (currentBlock.length === 0) {
      blockStartTs = msg.timestamp;
      blockId = `task-${msg.timestamp}`;
    } else if (msg.role === 'user') {
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      blockStartTs = msg.timestamp;
      blockId = `task-${msg.timestamp}`;
      currentBlock = [];
    }
    currentBlock.push(msg);
    if (isReasoningStopBoundary(msg)) {
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      currentBlock = [];
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
  }

  return blocks;
}

function normalizeSessionSnapshotMessages(
  messages: SessionSnapshotMessage[],
): TaskMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  return messages
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, index) => {
      const parsedTs = Date.parse(item.timestamp);
      const timestampMs = Number.isFinite(parsedTs) ? parsedTs : Date.now() + index;
      const metadata = item.metadata && typeof item.metadata === 'object'
        ? item.metadata
        : undefined;
      const role = normalizeTaskMessageRole(item.role);
      return {
        id: typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `session-msg-${timestampMs}-${index}`,
        role,
        content: item.content,
        timestamp: timestampMs,
        timestampIso: new Date(timestampMs).toISOString(),
        tokenCount: estimateTokens(item.content),
        messageId: typeof metadata?.messageId === 'string' && metadata.messageId.trim().length > 0
          ? metadata.messageId
          : undefined,
        metadata,
        attachments: compactAttachments(item.attachments ?? metadata?.attachments),
      } satisfies TaskMessage;
    });
}

function groupByTaskBoundaryFromSessionMessages(messages: SessionSnapshotMessage[]): TaskBlock[] {
  const normalized = normalizeSessionSnapshotMessages(messages);
  if (normalized.length === 0) return [];
  const hasUserBoundary = normalized.some((message) => message.role === 'user');
  if (!hasUserBoundary) {
    return groupWithoutUserBoundary(normalized);
  }
  const blocks: TaskBlock[] = [];
  let currentBlock: TaskMessage[] = [];
  let blockStartTs = 0;
  let blockId = '';

  for (const msg of normalized) {
    if (currentBlock.length === 0) {
      blockStartTs = msg.timestamp;
      blockId = `task-${msg.timestamp}`;
    } else if (msg.role === 'user') {
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      blockStartTs = msg.timestamp;
      blockId = `task-${msg.timestamp}`;
      currentBlock = [];
    }
    currentBlock.push(msg);
    if (isReasoningStopBoundary(msg)) {
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      currentBlock = [];
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
  }
  return blocks;
}

function finalizeBlock(id: string, startTs: number, messages: TaskMessage[]): TaskBlock {
  const endTs = messages.length > 0 ? messages[messages.length - 1].timestamp : startTs;
  const tokenCount = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  // Extract tags/topic from assistant message metadata (dispatch result)
  let tags: string[] | undefined;
  let topic: string | undefined;
  
  // Look for tags in assistant messages (dispatch completion writes tags to metadata)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    const metadata = msg.metadata;
    if (!metadata || typeof metadata !== 'object') continue;
    
    // Extract tags from metadata
    const metaTags = metadata.tags;
    if (Array.isArray(metaTags)) {
      const normalized = metaTags
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.trim());
      if (normalized.length > 0) {
        tags = tags ? [...new Set([...tags, ...normalized])] : normalized;
      }
    }
    
    // Extract topic from metadata
    const metaTopic = metadata.topic;
    if (typeof metaTopic === 'string' && metaTopic.trim().length > 0 && !topic) {
      topic = metaTopic.trim();
    }
  }

  return {
    id,
    startTime: startTs,
    endTime: endTs,
    startTimeIso: new Date(startTs).toISOString(),
    endTimeIso: new Date(endTs).toISOString(),
    messages,
    tokenCount,
    ...(tags ? { tags } : {}),
    ...(topic ? { topic } : {}),
  };
}

/**
 * 按预算截断任务块
 * - 当前任务块（最后一个 user 消息的块）必须保留
 * - 其他块按相关性排序后，从高到低填充预算
 * - 只在完整任务块边界截断（不拆分单个块）
 */
function applyBudgetTruncation(
  blocks: TaskBlock[],
  targetBudget: number,
  options?: { preferRecentForUnranked?: boolean },
): { included: TaskBlock[]; truncated: number } {
  if (blocks.length === 0) return { included: [], truncated: 0 };

  // 找到当前任务块（最后一块，包含最新消息）
  const lastBlock = blocks[blocks.length - 1];
  const otherBlocks = blocks.slice(0, -1);

  let budget = Math.max(0, targetBudget);
  const included: TaskBlock[] = [];

  // 先扣减 MEMORY.md 的预估 token（如果有）
  // MEMORY.md 通常占 500-2000 tokens，保守预留 2000
  // 这个预留由调用者在上层处理

  const fillCandidates = options?.preferRecentForUnranked
    ? [...otherBlocks].reverse()
    : otherBlocks;

  // 先填入非当前块（按排序顺序）
  for (const block of fillCandidates) {
    if (budget - block.tokenCount >= 0) {
      included.push(block);
      budget -= block.tokenCount;
    }
  }

  // 当前块必须保留
  included.push(lastBlock);
  budget -= lastBlock.tokenCount;

  const truncated = otherBlocks.length - (included.length - 1);

  return { included, truncated: Math.max(0, truncated) };
}

type RankingMode = 'off' | 'active' | 'dryrun';

interface TagSelectionOutput {
  selectedTags?: string[];
  selectedTaskIds?: string[];
}

function resolveRankingMode(flag: ContextBuildOptions['enableModelRanking'] | undefined): RankingMode {
  if (flag === 'dryrun') return 'dryrun';
  if (flag === true) return 'active';
  return 'off';
}

function normalizeTagToken(value: string): string {
  return value.trim().toLowerCase();
}

function collectTagCatalog(blocks: TaskBlock[]): string[] {
  const tags = new Set<string>();
  for (const block of blocks) {
    if (Array.isArray(block.tags)) {
      for (const tag of block.tags) {
        if (typeof tag !== 'string') continue;
        const normalized = normalizeTagToken(tag);
        if (normalized.length > 0) tags.add(normalized);
      }
    }
    if (typeof block.topic === 'string') {
      const topic = normalizeTagToken(block.topic);
      if (topic.length > 0) tags.add(topic);
    }
  }
  return Array.from(tags);
}

async function runModelRanking(
  blocks: TaskBlock[],
  params: {
    providerId?: string;
    currentPrompt?: string;
  },
): Promise<{
  rankedTaskIds: string[];
  providerId?: string;
  providerModel?: string;
  executed: boolean;
  reason: string;
}> {
  if (blocks.length <= 1) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false, reason: 'insufficient_blocks' };
  }
  const configuredProviderId = (params.providerId || '').trim();
  const defaultProviderResolved = resolveKernelProvider(undefined);
  const defaultProviderId = defaultProviderResolved.provider?.id?.trim() ?? '';
  const providerCandidates = [configuredProviderId, defaultProviderId]
    .filter((item, index, arr): item is string => item.length > 0 && arr.indexOf(item) === index);
  if (providerCandidates.length === 0) {
    return {
      rankedTaskIds: blocks.map((b) => b.id),
      executed: false,
      reason: `missing_provider_id:${defaultProviderResolved.reason ?? 'default_provider_unavailable'}`,
    };
  }
  const attempts: string[] = [];
  let latestProviderModel: string | undefined;
  let latestProviderId: string | undefined;
  for (const providerCandidateId of providerCandidates) {
    const singleResult = await runModelRankingWithProvider(blocks, params.currentPrompt, providerCandidateId);
    latestProviderModel = singleResult.providerModel ?? latestProviderModel;
    latestProviderId = singleResult.providerId ?? latestProviderId;
    if (singleResult.executed) {
      return singleResult;
    }
    attempts.push(`${providerCandidateId}:${singleResult.reason}`);
  }
  return {
    rankedTaskIds: blocks.map((b) => b.id),
    providerId: latestProviderId,
    providerModel: latestProviderModel,
    executed: false,
    reason: `providers_exhausted:${attempts.join('|')}`,
  };
}

async function runModelRankingWithProvider(
  blocks: TaskBlock[],
  currentPrompt: string | undefined,
  providerId: string,
): Promise<{
  rankedTaskIds: string[];
  providerId?: string;
  providerModel?: string;
  executed: boolean;
  reason: string;
}> {
  const providerResolved = resolveKernelProvider(providerId);
  const provider = providerResolved.provider;
  if (!provider) {
    return {
      rankedTaskIds: blocks.map((b) => b.id),
      providerId,
      executed: false,
      reason: providerResolved.reason ?? 'provider_not_found',
    };
  }
  if (provider.enabled === false) {
    return {
      rankedTaskIds: blocks.map((b) => b.id),
      providerId,
      providerModel: provider.model,
      executed: false,
      reason: 'provider_disabled',
    };
  }
  if (provider.wire_api !== 'responses') {
    return {
      rankedTaskIds: blocks.map((b) => b.id),
      providerId,
      providerModel: provider.model,
      executed: false,
      reason: `unsupported_wire_api:${provider.wire_api}`,
    };
  }
  const payload = {
    model: provider.model,
    reasoning: { effort: 'minimal' },
    text: { verbosity: 'low' },
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              '你是上下文相关性排序助手。',
              '',
              '任务：根据用户当前的输入意图，在历史对话任务中找到相关的执行记录，按「标签匹配优先，内容相关性次之，时间最后」的原则排序。',
              '',
              '排序原则（三重维度）：',
              '',
              '一、标签匹配（最高优先级）',
              '- 每个 task 可能带有 tags（分类标签）和 topic（主题）',
              '- 如果用户当前问题与 task 的 tags/topic 有匹配，优先级最高',
              '- 标签匹配是强信号，应优先考虑',
              '',
              '二、内容相关性（次要维度）',
              '- 高相关：task 直接涉及当前问题的话题/文件/概念',
              '- 中相关：task 与当前问题有间接关联（相关领域、依赖模块等）',
              '- 低相关：task 与当前问题无明显关联',
              '',
              '三、时间相关性（最后维度）',
              '- 在相同标签匹配和内容相关性级别内，时间更近的 task 排在前面',
              '- 最近的任务优先级更高，因为上下文更连贯',
              '',
              '判断内容相关性的依据：',
              '1. 标签匹配：task 的 tags/topic 是否与当前问题相关（最高优先）',
              '2. 话题匹配：task 讨论/解决的问题与当前问题是否同类',
              '3. 文件匹配：task 操作的文件/目录是否与当前问题相关',
              '4. 概念匹配：task 涉及的技术概念/术语是否与当前问题相关',
              '5. 结论复用：task 的结论/结果是否对解决当前问题有帮助',
              '',
              '最终排序：标签匹配(时间倒序) → 高相关(时间倒序) → 中相关(时间倒序) → 低相关(时间倒序)',
              '返回格式（严格 JSON，不要 markdown）：',
              '{"rankedTaskIds": ["task-id-1", "task-id-2", ...]}',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '【用户当前输入】',
              currentPrompt || '（无）',
              '',
              '【历史任务候选】',
              '以下是与用户当前会话相关的历史任务记录，请根据相关性排序：',
              '',
              blocks.map((b) => {
                const userMsg = b.messages.find((m) => m.role === 'user');
                const assistantMsgs = b.messages.filter((m) => m.role === 'assistant');
                const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
                const tagsLine = b.tags && b.tags.length > 0 ? `标签: ${b.tags.join(", ")}` : "";
                const topicLine = b.topic ? `主题: ${b.topic}` : "";
                const preview = [
                  `[${b.id}]`,
                  `时间: ${b.startTimeIso}`,
                  tagsLine,
                  topicLine,
                  userMsg ? `用户: ${userMsg.content.slice(0, 300)}` : "",
                  lastAssistant ? `助手: ${lastAssistant.content.slice(0, 500)}` : "",
                ].filter(Boolean).join("\n");
                return preview;
              }).join('\n\n'),
              '',
              '请返回排序后的 task ID 列表（JSON 格式）。',
            ].join('\n'),
          },
        ],
      },
    ],
  };

  try {
    const endpoints = buildResponsesEndpoints(provider.base_url);
    if (endpoints.length === 0) {
      return {
        rankedTaskIds: blocks.map((b) => b.id),
        providerId,
        providerModel: provider.model,
        executed: false,
        reason: 'provider_base_url_missing',
      };
    }
    const headers = buildProviderHeaders(provider);
    let response: Response | null = null;
    for (const endpoint of endpoints) {
      const candidate = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (candidate.status === 404) {
        response = candidate;
        continue;
      }
      response = candidate;
      break;
    }
    if (!response || !response.ok) {
      return {
        rankedTaskIds: blocks.map((b) => b.id),
        providerId,
        providerModel: provider.model,
        executed: false,
        reason: response ? `http_${response.status}` : 'http_unknown',
      };
    }
    const data = await response.json() as Record<string, unknown>;
    const outputText = extractResponseOutputText(data);
    if (!outputText) {
      return {
        rankedTaskIds: blocks.map((b) => b.id),
        providerId,
        providerModel: provider.model,
        executed: false,
        reason: 'empty_output',
      };
    }
    const parsed = tryParseRankingOutput(outputText);
    if (!parsed) {
      return {
        rankedTaskIds: blocks.map((b) => b.id),
        providerId,
        providerModel: provider.model,
        executed: false,
        reason: 'parse_failed',
      };
    }
    const allowed = new Set(blocks.map((b) => b.id));
    const deduped = parsed.rankedTaskIds.filter((id) => allowed.has(id));
    for (const b of blocks) {
      if (!deduped.includes(b.id)) deduped.push(b.id);
    }
    return {
      rankedTaskIds: deduped,
      providerId,
      providerModel: provider.model,
      executed: true,
      reason: 'ok',
    };
  } catch {
    return {
      rankedTaskIds: blocks.map((b) => b.id),
      providerId,
      providerModel: provider.model,
      executed: false,
      reason: 'exception',
    };
  }
}

function extractResponseOutputText(data: Record<string, unknown>): string {
  const outputText = data.output_text;
  if (typeof outputText === 'string' && outputText.trim().length > 0) return outputText;
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
      : [];
    for (const c of content) {
      const text = c?.text;
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  }
  return '';
}

function tryParseRankingOutput(text: string): RankingOutput | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    const ids = Array.isArray(parsed.rankedTaskIds)
      ? parsed.rankedTaskIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    if (ids.length === 0) return null;
    return { rankedTaskIds: ids };
  } catch {
    return null;
  }
}

function tryParseTagSelectionOutput(text: string): TagSelectionOutput | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    const selectedTags = Array.isArray(parsed.selectedTags)
      ? parsed.selectedTags
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => normalizeTagToken(v))
      : [];
    const selectedTaskIds = Array.isArray(parsed.selectedTaskIds)
      ? parsed.selectedTaskIds
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : [];
    if (selectedTags.length === 0 && selectedTaskIds.length === 0) return null;
    return {
      ...(selectedTags.length > 0 ? { selectedTags } : {}),
      ...(selectedTaskIds.length > 0 ? { selectedTaskIds } : {}),
    };
  } catch {
    return null;
  }
}

async function runModelTagSelection(
  blocks: TaskBlock[],
  params: {
    providerId?: string;
    currentPrompt?: string;
  },
): Promise<{
  selectedTags: string[];
  selectedTaskIds: string[];
  providerId?: string;
  providerModel?: string;
  executed: boolean;
  reason: string;
}> {
  if (blocks.length === 0) {
    return {
      selectedTags: [],
      selectedTaskIds: [],
      executed: false,
      reason: 'empty_blocks',
    };
  }
  const currentPrompt = typeof params.currentPrompt === 'string' ? params.currentPrompt.trim() : '';
  if (currentPrompt.length === 0) {
    return {
      selectedTags: [],
      selectedTaskIds: [],
      executed: false,
      reason: 'missing_prompt',
    };
  }
  const tagCatalog = collectTagCatalog(blocks);
  if (tagCatalog.length === 0) {
    return {
      selectedTags: [],
      selectedTaskIds: [],
      executed: false,
      reason: 'empty_tag_catalog',
    };
  }

  const configuredProviderId = (params.providerId || '').trim();
  const defaultProviderResolved = resolveKernelProvider(undefined);
  const defaultProviderId = defaultProviderResolved.provider?.id?.trim() ?? '';
  const providerCandidates = [configuredProviderId, defaultProviderId]
    .filter((item, index, arr): item is string => item.length > 0 && arr.indexOf(item) === index);
  if (providerCandidates.length === 0) {
    return {
      selectedTags: [],
      selectedTaskIds: [],
      executed: false,
      reason: `missing_provider_id:${defaultProviderResolved.reason ?? 'default_provider_unavailable'}`,
    };
  }

  const taskPreview = blocks.map((block) => {
    const blockTags = (block.tags ?? []).map((tag) => normalizeTagToken(tag)).filter((tag) => tag.length > 0);
    const topic = typeof block.topic === 'string' ? normalizeTagToken(block.topic) : '';
    const tokens = [
      `[${block.id}]`,
      blockTags.length > 0 ? `tags=${blockTags.join(',')}` : '',
      topic ? `topic=${topic}` : '',
      `time=${block.startTimeIso}`,
    ].filter((item) => item.length > 0);
    return tokens.join(' ');
  }).join('\n');

  const payloadBase = {
    reasoning: { effort: 'minimal' },
    text: { verbosity: 'low' },
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: [
              '你是上下文标签筛选助手。',
              '任务：根据用户当前输入，从给定 tags/topic 中选出最相关标签，并可选返回直接命中的 task IDs。',
              '规则：',
              '- 只可使用候选 tags，不要创造新标签；',
              '- 优先选择语义明确、与当前输入直接相关的标签；',
              '- 如果没有强相关标签，返回空数组；',
              '- JSON 输出，不要 markdown。',
              '输出格式：{"selectedTags":["tag1"],"selectedTaskIds":["task-id-1"]}',
            ].join('\n'),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `用户输入: ${currentPrompt}`,
              '',
              `候选标签: ${tagCatalog.join(', ')}`,
              '',
              '任务候选（仅供必要时返回 selectedTaskIds）：',
              taskPreview,
            ].join('\n'),
          },
        ],
      },
    ],
  };

  const attempts: string[] = [];
  let latestProviderModel: string | undefined;
  let latestProviderId: string | undefined;
  for (const providerCandidateId of providerCandidates) {
    const providerResolved = resolveKernelProvider(providerCandidateId);
    const provider = providerResolved.provider;
    if (!provider) {
      attempts.push(`${providerCandidateId}:${providerResolved.reason ?? 'provider_not_found'}`);
      continue;
    }
    latestProviderModel = provider.model;
    latestProviderId = provider.id;
    if (provider.enabled === false) {
      attempts.push(`${providerCandidateId}:provider_disabled`);
      continue;
    }
    if (provider.wire_api !== 'responses') {
      attempts.push(`${providerCandidateId}:unsupported_wire_api:${provider.wire_api}`);
      continue;
    }
    try {
      const payload = {
        ...payloadBase,
        model: provider.model,
      };
      const endpoints = buildResponsesEndpoints(provider.base_url);
      if (endpoints.length === 0) {
        attempts.push(`${providerCandidateId}:provider_base_url_missing`);
        continue;
      }
      const headers = buildProviderHeaders(provider);
      let response: Response | null = null;
      for (const endpoint of endpoints) {
        const candidate = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
        if (candidate.status === 404) {
          response = candidate;
          continue;
        }
        response = candidate;
        break;
      }
      if (!response || !response.ok) {
        attempts.push(`${providerCandidateId}:${response ? `http_${response.status}` : 'http_unknown'}`);
        continue;
      }
      const data = await response.json() as Record<string, unknown>;
      const outputText = extractResponseOutputText(data);
      if (!outputText) {
        attempts.push(`${providerCandidateId}:empty_output`);
        continue;
      }
      const parsed = tryParseTagSelectionOutput(outputText);
      if (!parsed) {
        attempts.push(`${providerCandidateId}:parse_failed`);
        continue;
      }
      const allowedTaskIds = new Set(blocks.map((block) => block.id));
      const selectedTaskIds = (parsed.selectedTaskIds ?? []).filter((id) => allowedTaskIds.has(id));
      const allowedTagSet = new Set(tagCatalog.map((tag) => normalizeTagToken(tag)));
      const selectedTags = (parsed.selectedTags ?? []).filter((tag) => allowedTagSet.has(normalizeTagToken(tag)));
      return {
        selectedTags,
        selectedTaskIds,
        providerId: provider.id,
        providerModel: provider.model,
        executed: true,
        reason: 'ok',
      };
    } catch {
      attempts.push(`${providerCandidateId}:exception`);
    }
  }
  return {
    selectedTags: [],
    selectedTaskIds: [],
    providerId: latestProviderId,
    providerModel: latestProviderModel,
    executed: false,
    reason: `providers_exhausted:${attempts.join('|')}`,
  };
}

function reorderBlocksByRanking(blocks: TaskBlock[], rankedTaskIds: string[]): TaskBlock[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const reordered: TaskBlock[] = [];
  for (const id of rankedTaskIds) {
    const hit = byId.get(id);
    if (hit) reordered.push(hit);
  }
  for (const block of blocks) {
    if (!reordered.includes(block)) reordered.push(block);
  }
  return reordered;
}

function reorderBlocksChronologically(blocks: TaskBlock[]): TaskBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    if (a.endTime !== b.endTime) return a.endTime - b.endTime;
    return a.id.localeCompare(b.id);
  });
}

function summarizeTaskBlock(block: TaskBlock): string | undefined {
  const firstUser = block.messages.find((message) => message.role === 'user')?.content?.trim() ?? '';
  if (firstUser.length === 0) return undefined;
  const normalized = firstUser.replace(/\s+/g, ' ');
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 120)}...`;
}

function toCompactTaskDigestBlock(block: TaskBlock): TaskBlock {
  const firstUser = block.messages.find((message) => message.role === 'user')?.content?.trim() ?? '';
  const lastAssistant = [...block.messages].reverse().find((message) => message.role === 'assistant' || message.role === 'orchestrator')?.content?.trim() ?? '';
  const toolNames = Array.from(new Set(
    block.messages
      .map((message) => {
        const raw = message.metadata?.toolName;
        return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : '';
      })
      .filter((item) => item.length > 0),
  )).slice(0, 8);
  const digestParts = [
    firstUser ? `请求: ${firstUser.replace(/\s+/g, ' ').slice(0, 220)}` : '',
    lastAssistant ? `结果: ${lastAssistant.replace(/\s+/g, ' ').slice(0, 260)}` : '',
    toolNames.length > 0 ? `工具: ${toolNames.join(', ')}` : '',
  ].filter((item) => item.length > 0);
  const digestContent = digestParts.length > 0 ? digestParts.join('\n') : `(task digest ${block.id})`;
  const digestId = `digest-${block.id}`;
  const digestMessage: TaskMessage = {
    id: `${digestId}-msg`,
    role: 'assistant',
    content: digestContent,
    timestamp: block.endTime,
    timestampIso: block.endTimeIso,
    tokenCount: estimateTokens(digestContent),
    messageId: digestId,
    metadata: {
      compactDigest: true,
      compactDigestFromTaskId: block.id,
      ...(block.topic ? { topic: block.topic } : {}),
      ...(block.tags && block.tags.length > 0 ? { tags: block.tags } : {}),
    },
  };
  return {
    id: digestId,
    startTime: block.startTime,
    endTime: block.endTime,
    startTimeIso: block.startTimeIso,
    endTimeIso: block.endTimeIso,
    messages: [digestMessage],
    tokenCount: digestMessage.tokenCount,
    ...(block.tags && block.tags.length > 0 ? { tags: block.tags } : {}),
    ...(block.topic ? { topic: block.topic } : {}),
  };
}

function toCompactTaskDigestBlocks(blocks: TaskBlock[]): TaskBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  return blocks.map((block) => toCompactTaskDigestBlock(block));
}

function resolveBuildMode(mode: ContextBuildOptions['buildMode'] | undefined): ContextBuildMode {
  if (mode === 'minimal' || mode === 'moderate' || mode === 'aggressive') return mode;
  return 'moderate';
}

function splitCurrentAndHistorical(blocks: TaskBlock[]): {
  current: TaskBlock | null;
  historical: TaskBlock[];
} {
  if (blocks.length === 0) return { current: null, historical: [] };
  const current = blocks[blocks.length - 1];
  const historical = blocks.slice(0, -1);
  return { current, historical };
}

function buildPromptTerms(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const lowered = prompt.toLowerCase();
  const terms = new Set<string>();
  const english = lowered.match(/[a-z0-9_.-]{2,}/g) ?? [];
  const chinese = lowered.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const term of [...english, ...chinese]) {
    const normalized = term.trim();
    if (normalized.length < 2) continue;
    terms.add(normalized);
  }
  return Array.from(terms);
}

function taskBlockMatchesPrompt(block: TaskBlock, promptTerms: string[]): boolean {
  if (promptTerms.length === 0) return false;
  const tagText = (block.tags ?? []).join(' ').toLowerCase();
  const topicText = (block.topic ?? '').toLowerCase();
  const userText = block.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content.toLowerCase())
    .join('\n');
  const assistantText = block.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.toLowerCase())
    .join('\n');

  const searchable = `${tagText}\n${topicText}\n${userText}\n${assistantText}`;
  return promptTerms.some((term) => searchable.includes(term));
}

function applyModerateSupplement(params: {
  relatedBlocks: TaskBlock[];
  currentBlock: TaskBlock;
  removedBlocks: TaskBlock[];
  historicalPoolByRanking: TaskBlock[];
  effectiveBudget: number;
  currentPrompt?: string;
}): {
  blocks: TaskBlock[];
  supplementedCount: number;
  supplementedTokens: number;
} {
  const { relatedBlocks, currentBlock, removedBlocks, historicalPoolByRanking, effectiveBudget, currentPrompt } = params;
  const keptBlocks = [...relatedBlocks, currentBlock];
  const keptTokens = keptBlocks.reduce((sum, b) => sum + b.tokenCount, 0);
  if (keptTokens >= effectiveBudget) {
    return { blocks: keptBlocks, supplementedCount: 0, supplementedTokens: 0 };
  }

  const removedTokens = removedBlocks.reduce((sum, b) => sum + b.tokenCount, 0);
  const keptIds = new Set(keptBlocks.map((b) => b.id));
  let supplementedTokens = 0;
  const supplemented: TaskBlock[] = [];
  const promptTerms = buildPromptTerms(currentPrompt);

  for (const candidate of historicalPoolByRanking) {
    if (keptIds.has(candidate.id)) continue;
    if (supplemented.some((b) => b.id === candidate.id)) continue;
    if (!taskBlockMatchesPrompt(candidate, promptTerms)) continue;

    const newTotal = keptTokens + supplementedTokens + candidate.tokenCount;
    // 中等模式规则：
    // 1) 优先按“释放额度”补充
    // 2) 即便单个 task 超过释放额度，只要总预算不超，仍允许添加（用户指定）
    const withinReleasedBudget = supplementedTokens + candidate.tokenCount <= removedTokens;
    const withinContextBudget = newTotal <= effectiveBudget;
    if (!withinReleasedBudget && !withinContextBudget) {
      continue;
    }

    supplemented.push(candidate);
    supplementedTokens += candidate.tokenCount;

    if (keptTokens + supplementedTokens >= effectiveBudget) break;
  }

  return {
    // 当前 task 必须保持尾部（Jason 要求）
    blocks: [...relatedBlocks, ...supplemented, currentBlock],
    supplementedCount: supplemented.length,
    supplementedTokens,
  };
}

// ── MEMORY.md 读取 ────────────────────────────────────────────────────

/**
 * 读取 MEMORY.md 内容
 * 路径优先级：显式指定 > 项目根目录 MEMORY.md > 空
 */
function readMemoryMd(memoryMdPath?: string): { content: string; tokenCount: number } {
  const candidates = [
    memoryMdPath,
    process.cwd() + '/MEMORY.md',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf-8').trim();
        if (content.length > 0) {
          return { content, tokenCount: estimateTokens(content) };
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return { content: '', tokenCount: 0 };
}

// ── 主构建函数 ────────────────────────────────────────────────────────

export interface ContextBuilderInput {
  /** Ledger root directory */
  rootDir?: string;
  /** Session ID */
  sessionId: string;
  /** Agent ID */
  agentId: string;
  /** Mode (default: 'main') */
  mode?: string;
  /** 用户当前输入（用于相关性排序） */
  currentPrompt?: string;
  /** Runtime session snapshot messages; when provided, consumes this view instead of raw ledger replay. */
  sessionMessages?: SessionSnapshotMessage[];
}

/**
 * 构建动态上下文
 *
 * 流程：
 * 1. 从 Ledger 读取所有 session_message 条目
 * 2. 按任务边界分组
 * 3. 按预算截断
 * 4. 展平为消息列表（可选附加 MEMORY.md）
 */
export async function buildContext(
  input: ContextBuilderInput,
  options?: Partial<ContextBuildOptions>,
): Promise<ContextBuildResult> {
  const rootDir = normalizeRootDir(input.rootDir);
  const agentId = input.agentId || 'finger-system-agent';
  const mode = input.mode || 'main';
  const ledgerPath = resolveLedgerPath(rootDir, input.sessionId, agentId, mode);

  // 读取配置
  const contextWindow = getContextWindow();
  const targetBudget = options?.targetBudget ?? Math.floor(contextWindow * DEFAULT_BUDGET_RATIO);
  const enableTaskGrouping = options?.enableTaskGrouping !== false;
  const preferCompactHistory = options?.preferCompactHistory !== false;
  let digestCoverageCheck: DigestCoverageCheckResult | undefined;

  // ── Step 1: 读取 session 快照（优先）或 Ledger 条目 ──
  const snapshotMessages = Array.isArray(input.sessionMessages) ? input.sessionMessages : [];
  let messageEntries: LedgerEntryFile[] = [];
  if (snapshotMessages.length === 0) {
    const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
    messageEntries = allEntries.filter(
      (e) => e.event_type === 'session_message' && typeof (e.payload as Record<string, unknown>).content === 'string',
    );
  }

  // ── Step 2: 按任务边界分组 ──
  const rawBlocks = snapshotMessages.length > 0
    ? groupByTaskBoundaryFromSessionMessages(snapshotMessages)
    : enableTaskGrouping
      ? groupByTaskBoundary(messageEntries)
      : messageEntries.map((entry) => {
        const payload = entry.payload as Record<string, unknown>;
        return finalizeBlock(`task-${entry.timestamp_ms}`, entry.timestamp_ms, [{
      id: entry.id,
      role: normalizeTaskMessageRole(payload.role),
      content: payload.content as string,
      timestamp: entry.timestamp_ms,
      timestampIso: entry.timestamp_iso,
      tokenCount: typeof payload.token_count === 'number'
        ? Math.max(0, Math.floor(payload.token_count))
        : estimateTokens(payload.content as string),
      messageId: typeof payload.message_id === 'string' ? payload.message_id : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined,
      attachments: compactAttachments(payload.attachments),
    }]);
      });

  let normalizedRawBlocks = rawBlocks;
  if (snapshotMessages.length > 0 && preferCompactHistory) {
    digestCoverageCheck = await ensureCompactDigestCoverage({
      rootDir,
      sessionId: input.sessionId,
      agentId,
      mode,
    });
    if (digestCoverageCheck.backfilled) {
      log.info('Context rebuild auto backfilled missing digest coverage', {
        sessionId: input.sessionId,
        agentId,
        mode,
        ledgerSlots: digestCoverageCheck.ledgerSlots,
        maxCompactedSlot: digestCoverageCheck.maxCompactedSlot,
        missingSlots: digestCoverageCheck.missingSlots,
        taskDigestCount: digestCoverageCheck.taskDigestCount ?? 0,
      });
    } else if (digestCoverageCheck.error) {
      log.warn('Context rebuild digest backfill check failed', {
        sessionId: input.sessionId,
        agentId,
        mode,
        error: digestCoverageCheck.error,
        ledgerSlots: digestCoverageCheck.ledgerSlots,
        maxCompactedSlot: digestCoverageCheck.maxCompactedSlot,
        missingSlots: digestCoverageCheck.missingSlots,
      });
    }
    try {
      const compactHistoryBlocks = await loadCompactReplacementHistoryBlocks(rootDir, input.sessionId, agentId, mode);
      if (compactHistoryBlocks.length > 0) {
        const currentFromSnapshot = rawBlocks.length > 0 ? rawBlocks[rawBlocks.length - 1] : undefined;
        normalizedRawBlocks = currentFromSnapshot
          ? [...compactHistoryBlocks, currentFromSnapshot]
          : compactHistoryBlocks;
      }
    } catch (error) {
      log.debug('Failed to load compact replacement history, fallback to snapshot blocks', {
        sessionId: input.sessionId,
        agentId,
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rawTaskBlockCount = normalizedRawBlocks.length;

  // ── Step 3: 历史候选集合（不使用时间窗口过滤） ──
  let filteredBlocks = normalizedRawBlocks;
  const timeWindowFilteredCount = 0;
  const { current, historical } = splitCurrentAndHistorical(filteredBlocks);
  let rankedHistorical = historical;

  const rebuildTrigger = options?.rebuildTrigger ?? 'default';
  const useBootstrapTagSelection = rebuildTrigger === 'bootstrap_first';

  // ── Step 3.5: embedding recall（历史候选召回） ──
  const embeddingRecallEnabled = !useBootstrapTagSelection && options?.enableEmbeddingRecall !== false;
  let embeddingRecallExecuted = false;
  let embeddingCandidateCount = 0;
  let embeddingIndexPath: string | undefined;
  let embeddingRecallReason: string | undefined;
  let embeddingRecallError: string | undefined;
  let embeddingRecallIds: string[] | undefined;
  if (embeddingRecallEnabled) {
    const embeddingRecall = await runTaskEmbeddingRecall({
      rootDir,
      sessionId: input.sessionId,
      agentId,
      mode,
      blocks: historical,
      currentPrompt: input.currentPrompt,
      topK: options?.embeddingTopK,
    });
    embeddingRecallExecuted = embeddingRecall.executed;
    embeddingCandidateCount = embeddingRecall.candidateCount;
    embeddingIndexPath = embeddingRecall.indexPath;
    embeddingRecallReason = embeddingRecall.reason;
    embeddingRecallError = embeddingRecall.error;
    embeddingRecallIds = embeddingRecall.rankedTaskIds;
    if (embeddingRecall.executed) {
      rankedHistorical = reorderBlocksByRanking(historical, embeddingRecall.rankedTaskIds);
    }
  }

  // ── Step 4: 首次 bootstrap 重建：按 tag 相关性筛选（模型） ──
  let tagSelectionExecuted = false;
  let tagSelectionProviderId: string | undefined;
  let tagSelectionProviderModel: string | undefined;
  let tagSelectionReason: string | undefined;
  let selectedTags: string[] | undefined;
  let selectedTaskIds: string[] | undefined;
  if (useBootstrapTagSelection && rankedHistorical.length > 0) {
    const tagSelection = await runModelTagSelection(rankedHistorical, {
      providerId: options?.rankingProviderId,
      currentPrompt: input.currentPrompt,
    });
    tagSelectionExecuted = tagSelection.executed;
    tagSelectionProviderId = tagSelection.providerId;
    tagSelectionProviderModel = tagSelection.providerModel;
    tagSelectionReason = tagSelection.reason;
    selectedTags = tagSelection.selectedTags;
    selectedTaskIds = tagSelection.selectedTaskIds;
    if (tagSelection.executed) {
      const tagSet = new Set((tagSelection.selectedTags ?? []).map((tag) => normalizeTagToken(tag)));
      const selectedIdSet = new Set(tagSelection.selectedTaskIds ?? []);
      const filtered = rankedHistorical.filter((block) => {
        if (selectedIdSet.has(block.id)) return true;
        if (typeof block.topic === 'string' && tagSet.has(normalizeTagToken(block.topic))) return true;
        if (Array.isArray(block.tags)) {
          for (const tag of block.tags) {
            if (tagSet.has(normalizeTagToken(tag))) return true;
          }
        }
        return false;
      });
      if (filtered.length > 0) {
        // Filter by relevance, then sort by time (newer first for budget fill).
        rankedHistorical = [...filtered].sort((a, b) => b.endTime - a.endTime);
      }
    }
  }

  // ── Step 5: 可选模型排序（active/dryrun） ──
  const rankingMode = resolveRankingMode(options?.enableModelRanking);
  let rankingExecuted = false;
  let rankingProviderId: string | undefined;
  let rankingProviderModel: string | undefined;
  let rankingReason: string | undefined;
  let rankingIds: string[] | undefined;
  if (!useBootstrapTagSelection && (rankingMode === 'active' || rankingMode === 'dryrun') && rankedHistorical.length > 0) {
    const ranking = await runModelRanking(rankedHistorical, {
      providerId: options?.rankingProviderId,
      currentPrompt: input.currentPrompt,
    });
    rankingExecuted = ranking.executed;
    rankingProviderId = ranking.providerId;
    rankingProviderModel = ranking.providerModel;
    rankingReason = ranking.reason;
    rankingIds = ranking.rankedTaskIds;

    if (rankingMode === 'active' && ranking.executed) {
      rankedHistorical = reorderBlocksByRanking(rankedHistorical, ranking.rankedTaskIds);
    }
  } else if (embeddingRecallExecuted && embeddingRecallIds) {
    rankingIds = embeddingRecallIds;
    rankingReason = 'embedding_recall_only';
  } else if (useBootstrapTagSelection) {
    rankingReason = 'skipped_due_to_bootstrap_tag_selection';
  }

  const rankingUnavailableForFallback = !useBootstrapTagSelection
    && rankingMode === 'active'
    && rankedHistorical.length > 0
    && !rankingExecuted
    && typeof rankingReason === 'string'
    && rankingReason !== 'insufficient_blocks';
  const conservativeDigestFallback = rankingUnavailableForFallback;
  if (rankingUnavailableForFallback) {
    // Provider 不可用时：按 raw ledger 时间顺序做 digest，预算内保守加载
    rankedHistorical = toCompactTaskDigestBlocks(historical);
    rankingReason = `digest_fallback:${rankingReason}`;
  }

  // ── Step 5: 预算控制（不再为 MEMORY.md 预留） ──
  const memoryMdTokens = 0;
  const memoryMdIncluded = false;
  const effectiveBudget = Math.max(0, targetBudget);

  const buildMode = resolveBuildMode(options?.buildMode);
  let removedIrrelevantCount = 0;
  let removedTokens = 0;
  let supplementedCount = 0;
  let supplementedTokens = 0;
  filteredBlocks = current ? [...rankedHistorical, current] : rankedHistorical;

  if (current && conservativeDigestFallback) {
    filteredBlocks = [...rankedHistorical, current];
  } else if (current) {
    const rankedHistory = rankingIds
      ? reorderBlocksByRanking(rankedHistorical, rankingIds)
      : rankedHistorical;

    if (buildMode === 'minimal' || buildMode === 'moderate') {
      // related = 在 ranking 结果中靠前的历史块（若无 ranking 则全部视为相关）
      // 这里采用简单策略：
      // - model ranking 执行时：保留前 60% 作为“相关”
      // - 仅 embedding recall 执行时：保留 embedding topK 候选
      // - 否则：全部视为相关
      const relatedCutoff = rankingExecuted
        ? Math.max(1, Math.ceil(rankedHistory.length * 0.6))
        : embeddingRecallExecuted
          ? Math.max(1, Math.min(rankedHistory.length, embeddingCandidateCount))
          : rankedHistory.length;
      const related = rankedHistory.slice(0, relatedCutoff);
      const removed = rankedHistory.slice(relatedCutoff);

      removedIrrelevantCount = removed.length;
      removedTokens = removed.reduce((sum, b) => sum + b.tokenCount, 0);

      if (buildMode === 'minimal') {
        filteredBlocks = [...related, current];
      } else {
        const supplemented = applyModerateSupplement({
          relatedBlocks: related,
          currentBlock: current,
          removedBlocks: removed,
          historicalPoolByRanking: rankedHistory,
          effectiveBudget,
          currentPrompt: input.currentPrompt,
        });
        filteredBlocks = supplemented.blocks;
        supplementedCount = supplemented.supplementedCount;
        supplementedTokens = supplemented.supplementedTokens;
      }
    } else if (buildMode === 'aggressive') {
      filteredBlocks = [...rankedHistory, current];
    }
  }

  // ── Step 6: 预算截断 ──
  const preferRecentForUnranked = !rankingExecuted && !embeddingRecallExecuted && !tagSelectionExecuted;
  const { included, truncated } = applyBudgetTruncation(filteredBlocks, effectiveBudget, {
    preferRecentForUnranked,
  });
  const includedChronological = reorderBlocksChronologically(included);
  const includedIds = new Set(included.map((block) => block.id));
  const budgetTruncatedTasks = filteredBlocks
    .filter((block) => !includedIds.has(block.id))
    .map((block) => {
      const summary = summarizeTaskBlock(block);
      return {
        id: block.id,
        tokenCount: block.tokenCount,
        startTimeIso: block.startTimeIso,
        ...(block.topic ? { topic: block.topic } : {}),
        ...(block.tags && block.tags.length > 0 ? { tags: block.tags } : {}),
        ...(summary ? { summary } : {}),
      };
    });

  // ── Step 7: 展平为消息列表 ──
  const messages: TaskMessage[] = [];
  const workingSetBlockId = current?.id;
  const workingSetBlocks = includedChronological.filter((block) => block.id === workingSetBlockId);
  const historicalBlocksIncluded = includedChronological.filter((block) => block.id !== workingSetBlockId);
  for (const block of includedChronological) {
    const contextZone: ContextMessageZone = block.id === workingSetBlockId ? 'working_set' : 'historical_memory';
    for (const msg of block.messages) {
      messages.push({
        ...msg,
        contextZone,
        isCurrentTurn: block === includedChronological[includedChronological.length - 1]
          && msg === block.messages[block.messages.length - 1],
      });
    }
  }

  const actualTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0) + memoryMdTokens;
  const workingSetMessageCount = messages.filter((message) => message.contextZone === 'working_set').length;
  const historicalMessageCount = messages.filter((message) => message.contextZone === 'historical_memory').length;
  const workingSetTokens = messages
    .filter((message) => message.contextZone === 'working_set')
    .reduce((sum, message) => sum + message.tokenCount, 0);
  const historicalTokens = messages
    .filter((message) => message.contextZone === 'historical_memory')
    .reduce((sum, message) => sum + message.tokenCount, 0);

  log.info('Context build completed', {
    sessionId: input.sessionId,
    agentId,
    mode,
    rebuildTrigger,
    buildMode,
    targetBudget,
    actualTokens,
    rawTaskBlockCount,
    selectedTaskBlockCount: includedChronological.length,
    rankingMode,
    rankingExecuted,
    rankingReason: rankingReason ?? 'not_requested',
    rankingProviderId,
    rankingProviderModel,
    tagSelectionExecuted,
    tagSelectionReason: tagSelectionReason ?? 'not_requested',
    tagSelectionProviderId,
    tagSelectionProviderModel,
    embeddingRecallExecuted,
    embeddingRecallReason: embeddingRecallReason ?? 'not_requested',
    embeddingRecallError,
    removedIrrelevantCount,
    supplementedCount,
  });

  return {
    ok: true,
    messages,
    totalTokens: actualTokens,
    memoryMdIncluded,
    taskBlockCount: includedChronological.length,
    filteredTaskBlockCount: timeWindowFilteredCount + truncated,
    rankedTaskBlocks: includedChronological,
    buildTimestamp: new Date().toISOString(),
    metadata: {
      rawTaskBlockCount,
      timeWindowFilteredCount,
      budgetTruncatedCount: truncated,
      ...(budgetTruncatedTasks.length > 0 ? { budgetTruncatedTasks } : {}),
      targetBudget,
      actualTokens,
      buildMode,
      removedIrrelevantCount,
      removedTokens,
      supplementedCount,
      supplementedTokens,
      rankingExecuted,
      rankingMode,
      ...(rankingProviderId ? { rankingProviderId } : {}),
      ...(rankingProviderModel ? { rankingProviderModel } : {}),
      ...(rankingReason ? { rankingReason } : {}),
      ...(rankingIds ? { rankingIds } : {}),
      tagSelectionExecuted,
      ...(tagSelectionProviderId ? { tagSelectionProviderId } : {}),
      ...(tagSelectionProviderModel ? { tagSelectionProviderModel } : {}),
      ...(tagSelectionReason ? { tagSelectionReason } : {}),
      ...(selectedTags && selectedTags.length > 0 ? { selectedTags } : {}),
      ...(selectedTaskIds && selectedTaskIds.length > 0 ? { selectedTaskIds } : {}),
      embeddingRecallExecuted,
      embeddingCandidateCount,
      ...(embeddingRecallReason ? { embeddingRecallReason } : {}),
      ...(embeddingIndexPath ? { embeddingIndexPath } : {}),
      ...(embeddingRecallError ? { embeddingRecallError } : {}),
      ...(digestCoverageCheck
        ? {
          digestCoverageChecked: digestCoverageCheck.checked,
          digestCoverageLedgerSlots: digestCoverageCheck.ledgerSlots,
          digestCoverageCompactEntries: digestCoverageCheck.compactEntries,
          digestCoverageMaxCompactedSlot: digestCoverageCheck.maxCompactedSlot,
          digestCoverageMissingSlots: digestCoverageCheck.missingSlots,
          digestCoverageBackfilled: digestCoverageCheck.backfilled,
          ...(typeof digestCoverageCheck.taskDigestCount === 'number'
            ? { digestCoverageTaskDigestCount: digestCoverageCheck.taskDigestCount }
            : {}),
          ...(digestCoverageCheck.note ? { digestCoverageNote: digestCoverageCheck.note } : {}),
          ...(digestCoverageCheck.error ? { digestCoverageError: digestCoverageCheck.error } : {}),
        }
        : {}),
      workingSetTaskBlockCount: workingSetBlocks.length,
      historicalTaskBlockCount: historicalBlocksIncluded.length,
      workingSetMessageCount,
      historicalMessageCount,
      workingSetTokens,
      historicalTokens,
      workingSetBlockIds: workingSetBlocks.map((block) => block.id),
      historicalBlockIds: historicalBlocksIncluded.map((block) => block.id),
    },
  };
}

/**
 * 构建 MEMORY.md 注入消息
 * 将 MEMORY.md 内容包装为 system 角色消息，便于注入上下文
 */
export function buildMemoryMdInjection(memoryMdPath?: string): {
  role: 'system';
  content: string;
  tokenCount: number;
} | null {
  const md = readMemoryMd(memoryMdPath);
  if (md.content.length === 0) return null;

  return {
    role: 'system',
    content: `<memory>\n${md.content}\n</memory>`,
    tokenCount: md.tokenCount + 20, // 额外 20 tokens 用于标签
  };
}

// ── 导出类型 ──────────────────────────────────────────────────────────

export type {
  TaskBlock,
  TaskMessage,
  ContextBuildOptions,
  ContextBuildResult,
} from './context-builder-types.js';
