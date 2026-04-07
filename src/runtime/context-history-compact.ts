/**
 * Context History Compact - 确定性压缩（不需要 LLM）
 *
 * 架构：
 * - currentHistory: 当前活跃消息（在 context-ledger.jsonl）
 * - contextHistory: 已压缩历史摘要（在 compact-memory.jsonl）
 *
 * Compact 流程：
 * 1. currentHistory → deterministic digest (提取关键字段)
 * 2. digest → append to contextHistory
 * 3. 清空 currentHistory
 * 4. 如果 contextHistory 超预算 → 移除最旧的 digest
 */

import type { Session } from '../orchestration/session-types.js';
import type { LedgerEntryFile, CompactMemoryEntryFile } from './context-ledger-memory-types.js';
import type { SessionMessage } from '../orchestration/session-types.js';
import {
  normalizeRootDir,
  readJsonLines,
  appendLedgerEvent,
  resolveLedgerPath,
  resolveCompactMemoryPath,
  resolveBaseDir,
  
} from './context-ledger-memory-helpers.js';
import { buildContext } from './context-builder.js';
import { estimateTokens } from '../utils/token-counter.js';
import { logger } from '../core/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

const log = logger.module('context-history-compact');

// ─── Digest 格式（不需要 LLM）───────────────────────────────────

export interface DigestMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  /** 内容截断到 500 字符 */
  content_summary: string;
  /** 提取的 tool 调用名称 */
  tool_calls?: string[];
  /** 提取的关键实体（文件路径、URL 等） */
  key_entities?: string[];
  /** token 估算 */
  token_count: number;
}

export interface DigestBlock {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  event_type: 'digest_block';
  payload: {
    messages: DigestMessage[];
    total_tokens: number;
    source_range: {
      start: number;
      end: number;
    };
  };
}

// ─── Session 新增字段（兼容旧 session）───────────────────────────────────

export interface ContextHistoryPointers {
  /** 当前历史在 context-ledger.jsonl 的起始行号 */
  currentHistoryStart: number;
  /** 当前历史在 context-ledger.jsonl 的结束行号 */
  currentHistoryEnd: number;
  /** 当前历史的 token 数 */
  currentHistoryTokens: number;
  /** context history 在 compact-memory.jsonl 的起始行号 */
  contextHistoryStart: number;
  /** context history 在 compact-memory.jsonl 的结束行号 */
  contextHistoryEnd: number;
  /** context history 的 token 数 */
  contextHistoryTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** token 预算上限 */
  tokenBudget: number;
}

/** 默认 token 预算：100k tokens */
const CONTEXT_HISTORY_BUDGET = 20_000;

/** 内容截断长度 */
const MAX_CONTENT_SUMMARY_LENGTH = 500;

/** 最大保留 digest 条数 */
const MAX_DIGEST_ENTRIES = 50;

// ─── Deterministic Digest 生成（不需要 LLM）───────────────────────────────

/**
 * 从 SessionMessage 提取 deterministic digest
 */
function toDigestMessage(msg: SessionMessage): DigestMessage {
  // 内容截断
  const contentSummary = msg.content.length > MAX_CONTENT_SUMMARY_LENGTH
    ? msg.content.slice(0, MAX_CONTENT_SUMMARY_LENGTH) + '...'
    : msg.content;

  // 提取 tool 调用
  const toolCalls: string[] = [];
  if (msg.toolName) {
    toolCalls.push(msg.toolName);
  }
  // 从 metadata 提取更多 tool 调用
  if (msg.metadata?.tool_calls && Array.isArray(msg.metadata.tool_calls)) {
    for (const tc of msg.metadata.tool_calls as unknown[]) {
      if (tc && typeof tc === 'object' && 'name' in tc) {
        toolCalls.push((tc as { name: string }).name);
      }
    }
  }

  // 提取关键实体（文件路径、URL 等）
  const keyEntities: string[] = [];
  const entityPatterns = [
    /\/[\w\-./]+/g,                    // 文件路径
    /https?:\/\/[^\s]+/g,              // URL
    /~\/[\w\-./]+/g,                   // home 路径
  ];
  for (const pattern of entityPatterns) {
    const matches = contentSummary.match(pattern);
    if (matches) {
      keyEntities.push(...matches.slice(0, 5));  // 每种类型最多 5 个
    }
  }

  // token 估算
  const tokenCount = estimateTokens(contentSummary);

  return {
    id: msg.id,
    timestamp: msg.timestamp,
    role: msg.role,
    content_summary: contentSummary,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    key_entities: keyEntities.length > 0 ? keyEntities : undefined,
    token_count: tokenCount,
  };
}

/**
 * 从 SessionMessage[] 生成 DigestBlock
 */
function toDigestBlock(
  messages: SessionMessage[],
  sessionId: string,
  agentId: string,
  mode: string,
  sourceRange: { start: number; end: number },
): DigestBlock {
  const digestMessages = messages.map(toDigestMessage);
  const totalTokens = digestMessages.reduce((sum, m) => sum + m.token_count, 0);

  const now = Date.now();
  return {
    id: `digest-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: {
      messages: digestMessages,
      total_tokens: totalTokens,
      source_range: sourceRange,
    },
  };
}

// ─── Compact 核心逻辑 ─────────────────────────────────────────────

export interface CompactOptions {
  agentId?: string;
  mode?: string;
  rootDir?: string;
  /** token 预算上限（超过此值触发 compact） */
  tokenBudget?: number;
  /** 是否强制压缩（忽略 token 预算检查） */
  force?: boolean;
}

export interface CompactResult {
  compressed: boolean;
  reason?: string;
  pointers: ContextHistoryPointers;
  digestBlock?: DigestBlock;
}

/**
 * Compact Session 的当前历史到 Context History
 *
 * 流程（不需要 LLM）：
 * 1. currentHistory → deterministic digest
 * 2. digest → append to compact-memory.jsonl
 * 3. 清空 currentHistory
 * 4. 如果 contextHistory 超预算 → 移除最旧的 digest
 */
export async function compactSessionHistory(
  session: Session,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const agentId = options.agentId || 'finger-system-agent';
  const mode = options.mode || 'main';
  const rootDir = normalizeRootDir(options.rootDir);
  const tokenBudget = options.tokenBudget ?? CONTEXT_HISTORY_BUDGET;

  // 读取当前 Session 的指针（兼容旧 session）
  const pointers = extractContextHistoryPointers(session, tokenBudget);

  // 检查是否需要压缩
  if (!options.force && pointers.totalTokens < tokenBudget) {
    return {
      compressed: false,
      reason: `totalTokens (${pointers.totalTokens}) < tokenBudget (${tokenBudget})`,
      pointers,
    };
  }

  // 检查是否有 currentHistory 需要压缩
  if (pointers.currentHistoryStart > pointers.currentHistoryEnd) {
    return {
      compressed: false,
      reason: 'No current history to compress (start > end)',
      pointers,
    };
  }

  log.info('[compactSessionHistory] Starting compact', {
    sessionId: session.id,
    currentHistoryTokens: pointers.currentHistoryTokens,
    contextHistoryTokens: pointers.contextHistoryTokens,
    totalTokens: pointers.totalTokens,
    tokenBudget,
  });

  // Step 1: 读取 currentHistory
  const ledgerPath = resolveLedgerPath(rootDir, session.id, agentId, mode);
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const messageEntries = allEntries.filter(e => e.event_type === 'session_message');

  const currentMessages: SessionMessage[] = [];
  for (let i = pointers.currentHistoryStart; i <= Math.min(pointers.currentHistoryEnd, messageEntries.length - 1); i++) {
    const entry = messageEntries[i];
    const payload = entry.payload as Record<string, unknown>;
    currentMessages.push({
      id: entry.id,
      role: (payload.role as SessionMessage['role']) || 'user',
      content: typeof payload.content === 'string' ? payload.content : '',
      timestamp: entry.timestamp_iso,
      metadata: entry.payload as Record<string, unknown>,
    });
  }

  if (currentMessages.length === 0) {
    return {
      compressed: false,
      reason: 'No messages in current history',
      pointers,
    };
  }

  // Step 2: 生成 deterministic digest
  const digestBlock = toDigestBlock(
    currentMessages,
    session.id,
    agentId,
    mode,
    { start: pointers.currentHistoryStart, end: pointers.currentHistoryEnd },
  );

  log.info('[compactSessionHistory] Generated digest block', {
    digestId: digestBlock.id,
    messageCount: currentMessages.length,
    tokenCount: digestBlock.payload.total_tokens,
  });

  // Step 3: 写入 compact-memory.jsonl
  const compactPath = resolveCompactMemoryPath(rootDir, session.id, agentId, mode);
  const baseDir = resolveBaseDir(rootDir, session.id, agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });
  await appendLedgerEvent(compactPath, {
    session_id: session.id,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: digestBlock.payload as Record<string, unknown>,
  });

  // 更新指针
  const newContextHistoryEnd = pointers.contextHistoryEnd + 1;
  let newContextHistoryTokens = pointers.contextHistoryTokens + digestBlock.payload.total_tokens;

  // Step 4: 预算管理（移除最旧的 digest）
  const compactEntries = await readJsonLines<LedgerEntryFile>(compactPath);
  let newContextHistoryStart = pointers.contextHistoryStart;

  while (newContextHistoryTokens > tokenBudget * 0.5 && (newContextHistoryEnd - newContextHistoryStart) > MAX_DIGEST_ENTRIES) {
    const oldestEntry = compactEntries[newContextHistoryStart];
    if (oldestEntry && oldestEntry.event_type === 'digest_block') {
      const payload = oldestEntry.payload as { total_tokens?: number };
      if (typeof payload.total_tokens === 'number') {
        newContextHistoryTokens -= payload.total_tokens;
        newContextHistoryStart++;
        log.info('[compactSessionHistory] Removed oldest digest', {
          removedDigestId: oldestEntry.id,
          newContextHistoryTokens,
        });
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // Step 5: 更新指针
  const newPointers: ContextHistoryPointers = {
    currentHistoryStart: pointers.currentHistoryEnd + 1,
    currentHistoryEnd: pointers.currentHistoryEnd,
    currentHistoryTokens: 0,
    contextHistoryStart: newContextHistoryStart,
    contextHistoryEnd: newContextHistoryEnd,
    contextHistoryTokens: newContextHistoryTokens,
    totalTokens: newContextHistoryTokens,
    tokenBudget,
  };

  // Step 5: 重建上下文（compact + rebuild 是一体的）
  // 更新 session 指针并触发 context rebuild
  updateContextHistoryPointers(session, newPointers);
  
  try {
    const rebuiltContext = await buildContext({
      sessionId: session.id,
      agentId,
      mode,
      rootDir,
    });
    log.info('[compactSessionHistory] Context rebuilt', {
      sessionId: session.id,
      messageCount: rebuiltContext.messages?.length || 0,
      tokenCount: rebuiltContext.totalTokens || 0,
    });
  } catch (rebuildError) {
    log.error('[compactSessionHistory] Context rebuild failed', rebuildError as Error, {
      sessionId: session.id,
    });
  }

  log.info('[compactSessionHistory] Compact completed', {
    newPointers,
  });

  return {
    compressed: true,
    pointers: newPointers,
    digestBlock,
  };
}

// ─── Session 指针提取/更新（兼容旧 session）───────────────────────────────

/**
 * 从 Session 提取 ContextHistoryPointers（兼容旧 session）
 */
export function extractContextHistoryPointers(session: Session, tokenBudget?: number): ContextHistoryPointers {
  const context = session.context || {};
  
  // 优先使用 pointers 新架构
  const ptr = session.pointers;
  
  let currentHistoryStart: number;
  let currentHistoryEnd: number;
  let currentHistoryTokens: number;
  let contextHistoryStart: number;
  let contextHistoryEnd: number;
  let contextHistoryTokens: number;
  
  if (ptr) {
    currentHistoryStart = ptr.currentHistory.startLine;
    currentHistoryEnd = ptr.currentHistory.endLine;
    currentHistoryTokens = ptr.currentHistory.estimatedTokens;
    contextHistoryStart = ptr.contextHistory.startLine;
    contextHistoryEnd = ptr.contextHistory.endLine;
    contextHistoryTokens = ptr.contextHistory.estimatedTokens;
  } else {
    currentHistoryStart = typeof context.currentHistoryStart === 'number' 
      ? context.currentHistoryStart 
      : session.originalStartIndex ?? 0;
    currentHistoryEnd = typeof context.currentHistoryEnd === 'number'
      ? context.currentHistoryEnd
      : session.originalEndIndex ?? 0;
    currentHistoryTokens = typeof context.currentHistoryTokens === 'number'
      ? context.currentHistoryTokens
      : session.totalTokens ?? 0;
    contextHistoryStart = typeof context.contextHistoryStart === 'number'
      ? context.contextHistoryStart
      : 0;
    contextHistoryEnd = typeof context.contextHistoryEnd === 'number'
      ? context.contextHistoryEnd
      : session.latestCompactIndex ?? -1;
    contextHistoryTokens = typeof context.contextHistoryTokens === 'number'
      ? context.contextHistoryTokens
      : 0;
  }
  
  // 指针倒置检测与修复
  // 如果 currentHistoryStart > currentHistoryEnd，说明之前压缩后指针没正确更新
  // 此时应该将 currentHistoryEnd 重置为 currentHistoryStart（空窗口）
  if (currentHistoryStart > currentHistoryEnd) {
    log.warn('[extractContextHistoryPointers] Pointer inversion detected, resetting', {
      sessionId: session.id,
      currentHistoryStart,
      currentHistoryEnd,
      action: 'reset currentHistoryEnd to currentHistoryStart',
    });
    currentHistoryEnd = currentHistoryStart;
    currentHistoryTokens = 0;
  }
  
  const totalTokens = currentHistoryTokens + contextHistoryTokens;
  
  return {
    currentHistoryStart,
    currentHistoryEnd,
    currentHistoryTokens,
    contextHistoryStart,
    contextHistoryEnd,
    contextHistoryTokens,
    totalTokens,
    tokenBudget: tokenBudget ?? CONTEXT_HISTORY_BUDGET,
  };
}

/**
 * 更新 Session 的 ContextHistoryPointers
 */
export function updateContextHistoryPointers(session: Session, pointers: ContextHistoryPointers): void {
  // 更新 context（旧方式）
  session.context = session.context || {};
  session.context.currentHistoryStart = pointers.currentHistoryStart;
  session.context.currentHistoryEnd = pointers.currentHistoryEnd;
  session.context.currentHistoryTokens = pointers.currentHistoryTokens;
  session.context.contextHistoryStart = pointers.contextHistoryStart;
  session.context.contextHistoryEnd = pointers.contextHistoryEnd;
  session.context.contextHistoryTokens = pointers.contextHistoryTokens;
  session.totalTokens = pointers.totalTokens;
  
  // 更新 pointers（新架构）
  session.pointers = {
    contextHistory: {
      startLine: pointers.contextHistoryStart,
      endLine: pointers.contextHistoryEnd,
      estimatedTokens: pointers.contextHistoryTokens,
    },
    currentHistory: {
      startLine: pointers.currentHistoryStart,
      endLine: pointers.currentHistoryEnd,
      estimatedTokens: pointers.currentHistoryTokens,
    },
  };
  
  // 兼容旧字段
  session.latestCompactIndex = pointers.contextHistoryEnd;
  session.originalStartIndex = pointers.currentHistoryStart;
  session.originalEndIndex = pointers.currentHistoryEnd;
}

// ─── Turn-level Digest（finish_reason = stop 时触发）───────────────────────────────────

/**
 * Turn-level Digest Block（单条消息摘要 + tags）
 */
export interface TurnDigestBlock {
  id: string;
  timestamp_ms: number;
  timestamp_iso: string;
  session_id: string;
  agent_id: string;
  mode: string;
  event_type: 'digest_block';
  payload: {
    messages: DigestMessage[];
    tags: string[];
    total_tokens: number;
    /** Turn-level digest 不需要 source_range */
    turn_digest: true;
  };
}

/**
 * Turn-level digest 选项
 */
export interface AppendDigestForTurnOptions {
  /** 来自 controlBlock.tags */
  tags: string[];
  /** 当前轮的消息 */
  currentMessage: SessionMessage;
  /** agentId */
  agentId: string;
  /** mode */
  mode?: string;
}

/**
 * finish_reason = stop 时自动生成 digest + 保存 tags
 *
 * 流程：
 * 1. 生成 DigestMessage（截断内容 + 提取工具调用）
 * 2. 写入 compact-memory.jsonl（带 tags）
 *
 * @param sessionId - Session ID
 * @param rootDir - Sessions root directory
 * @param options - Turn digest options
 */
export async function appendDigestForTurn(
  sessionId: string,
  rootDir: string,
  options: AppendDigestForTurnOptions,
): Promise<void> {
  const normalizedRootDir = normalizeRootDir(rootDir);
  const agentId = options.agentId || 'finger-system-agent';
  const mode = options.mode || 'main';

  // Step 1: 生成 DigestMessage
  const digestMessage = toDigestMessage(options.currentMessage);

  // Step 2: 构建 TurnDigestBlock
  const now = Date.now();
  const digestBlock: TurnDigestBlock = {
    id: `digest-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    session_id: sessionId,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: {
      messages: [digestMessage],
      tags: options.tags,
      total_tokens: digestMessage.token_count,
      turn_digest: true,
    },
  };

  // Step 3: 确保 baseDir 存在
  const compactPath = resolveCompactMemoryPath(normalizedRootDir, sessionId, agentId, mode);
  const baseDir = resolveBaseDir(normalizedRootDir, sessionId, agentId, mode);
  await fs.mkdir(baseDir, { recursive: true });

  // Step 4: 写入 compact-memory.jsonl
  await appendLedgerEvent(compactPath, {
    session_id: sessionId,
    agent_id: agentId,
    mode,
    event_type: 'digest_block',
    payload: digestBlock.payload as Record<string, unknown>,
  });

  log.info('[appendDigestForTurn] Turn digest appended', {
    sessionId,
    agentId,
    digestId: digestBlock.id,
    tags: options.tags,
    tokenCount: digestMessage.token_count,
  });
}
