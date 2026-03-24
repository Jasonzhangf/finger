/**
 * Context Builder - 动态上下文构建器
 *
 * 职责：
 * 1. 读取 MEMORY.md 作为强制性长期记忆上下文
 * 2. 从 Ledger 读取历史记录（只读）
 * 3. 24小时半衰期时间窗口过滤
 * 4. 任务边界分组（一次完整用户请求 = 一个 task）
 * 5. 模型辅助排序（可选）
 * 6. 预算控制组装上下文
 *
 * 设计原则：
 * - Ledger 是唯一真源，不截断原始数据
 * - 截断只发生在构建 session 时
 * - MEMORY.md 是强制上下文
 */

import * as fs from 'fs';
import * as path from 'path';
import { estimateTokens } from '../utils/token-counter.js';
import { getContextWindow } from '../core/user-settings.js';
import {
  readJsonLines,
  normalizeRootDir,
  resolveLedgerPath,
} from './context-ledger-memory-helpers.js';
import type {
  LedgerEntryFile,
  CompactMemoryEntryFile,
} from './context-ledger-memory-types.js';
import type {
  TaskBlock,
  TaskMessage,
  ContextBuildOptions,
  ContextBuildResult,
  TimeWindowFilterOptions,
} from './context-builder-types.js';

// ── 常量 ──────────────────────────────────────────────────────────────

const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_OVER_THRESHOLD_RELEVANCE = 0.5; // 超过24h后相关性阈值
const DEFAULT_BUDGET_RATIO = 0.85; // 目标上下文占模型窗口的比例

// ── 工具函数 ──────────────────────────────────────────────────────────

/**
 * 按任务边界分组 ledger 条目
 * 任务 = 从一个 user 消息开始，到下一个 user 消息之前的所有消息
 * 最后一个任务块包含到最新记录
 */
function groupByTaskBoundary(entries: LedgerEntryFile[]): TaskBlock[] {
  if (entries.length === 0) return [];

  const blocks: TaskBlock[] = [];
  let currentBlock: TaskMessage[] = [];
  let blockStartTs = entries[0].timestamp_ms;
  let blockId = `task-${entries[0].timestamp_ms}`;

  for (const entry of entries) {
    const payload = entry.payload as Record<string, unknown>;
    const role = (payload.role as string) || 'system';
    const content = typeof payload.content === 'string' ? payload.content : '';
    const tokenCount = typeof payload.token_count === 'number'
      ? Math.max(0, Math.floor(payload.token_count))
      : estimateTokens(content);

    const msg: TaskMessage = {
      id: entry.id,
      role: role as TaskMessage['role'],
      content,
      timestamp: entry.timestamp_ms,
      timestampIso: entry.timestamp_iso,
      tokenCount,
    };

    // 新的 user 消息 = 新任务开始（除非是第一个块）
    if (role === 'user' && currentBlock.length > 0) {
      // 关闭当前块
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      // 开始新块
      blockStartTs = entry.timestamp_ms;
      blockId = `task-${entry.timestamp_ms}`;
      currentBlock = [msg];
    } else {
      currentBlock.push(msg);
    }
  }

  // 关闭最后一个块
  if (currentBlock.length > 0) {
    blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
  }

  return blocks;
}

function finalizeBlock(id: string, startTs: number, messages: TaskMessage[]): TaskBlock {
  const endTs = messages.length > 0 ? messages[messages.length - 1].timestamp : startTs;
  const tokenCount = messages.reduce((sum, m) => sum + m.tokenCount, 0);

  return {
    id,
    startTime: startTs,
    endTime: endTs,
    startTimeIso: new Date(startTs).toISOString(),
    endTimeIso: new Date(endTs).toISOString(),
    messages,
    tokenCount,
  };
}

/**
 * 24小时半衰期时间窗口过滤
 * - 24小时内的全部保留
 * - 超过24小时只保留相关性非常高的部分
 *   （当前阶段相关性无法计算，使用启发式规则：
 *    包含 user 消息且有 substantial 内容的保留）
 */
function applyTimeWindowFilter(
  blocks: TaskBlock[],
  options: TimeWindowFilterOptions,
): TaskBlock[] {
  const halfLifeMs = options.halfLifeMs ?? DEFAULT_HALF_LIFE_MS;
  const cutoff = options.nowMs - halfLifeMs;

  const recent: TaskBlock[] = [];
  const old: TaskBlock[] = [];

  for (const block of blocks) {
    // 块的任何部分在24小时内的都算"近期"
    if (block.endTime >= cutoff) {
      recent.push(block);
    } else {
      old.push(block);
    }
  }

  // 近期块全部保留，按时间升序
  recent.sort((a, b) => a.startTime - b.startTime);

  // 旧块：只保留有 substantial user 消息的块
  const overThreshold = options.overThresholdRelevance ?? DEFAULT_OVER_THRESHOLD_RELEVANCE;
  const keptOld = old
    .filter((block) => {
      const hasSubstantialUserMsg = block.messages.some(
        (m) => m.role === 'user' && m.tokenCount > 20,
      );
      return hasSubstantialUserMsg;
    })
    .sort((a, b) => b.startTime - a.startTime); // 旧的按时间倒序，最新的旧块优先

  return [...recent, ...keptOld];
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

  // 先填入非当前块（按排序顺序）
  for (const block of otherBlocks) {
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
}

/**
 * 构建动态上下文
 *
 * 流程：
 * 1. 从 Ledger 读取所有 session_message 条目
 * 2. 按任务边界分组
 * 3. 24小时半衰期过滤
 * 4. 按预算截断
 * 5. 展平为消息列表（可选附加 MEMORY.md）
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
  const includeMemoryMd = options?.includeMemoryMd !== false; // 默认包含
  const enableTaskGrouping = options?.enableTaskGrouping !== false;

  // ── Step 1: 读取 Ledger 条目 ──
  const allEntries = await readJsonLines<LedgerEntryFile>(ledgerPath);
  const messageEntries = allEntries.filter(
    (e) => e.event_type === 'session_message' && typeof (e.payload as Record<string, unknown>).content === 'string',
  );

  // ── Step 2: 按任务边界分组 ──
  const rawBlocks = enableTaskGrouping
    ? groupByTaskBoundary(messageEntries)
    : messageEntries.map((entry) => {
        const payload = entry.payload as Record<string, unknown>;
        return finalizeBlock(`task-${entry.timestamp_ms}`, entry.timestamp_ms, [{
          id: entry.id,
          role: (payload.role as TaskMessage['role']) || 'user',
          content: payload.content as string,
          timestamp: entry.timestamp_ms,
          timestampIso: entry.timestamp_iso,
          tokenCount: typeof payload.token_count === 'number'
            ? Math.max(0, Math.floor(payload.token_count))
            : estimateTokens(payload.content as string),
        }]);
      });

  const rawTaskBlockCount = rawBlocks.length;

  // ── Step 3: 时间窗口过滤 ──
  let filteredBlocks = rawBlocks;
  let timeWindowFilteredCount = 0;
  if (options?.timeWindow) {
    filteredBlocks = applyTimeWindowFilter(rawBlocks, options.timeWindow);
    timeWindowFilteredCount = rawBlocks.length - filteredBlocks.length;
  }

  // ── Step 4: MEMORY.md 预算预留 ──
  let memoryMdTokens = 0;
  let memoryMdContent = '';
  let memoryMdIncluded = false;
  if (includeMemoryMd) {
    const md = readMemoryMd(options?.memoryMdPath);
    if (md.content.length > 0) {
      memoryMdContent = md.content;
      memoryMdTokens = md.tokenCount;
      memoryMdIncluded = true;
    }
  }

  const effectiveBudget = Math.max(0, targetBudget - memoryMdTokens);

  // ── Step 5: 预算截断 ──
  const { included, truncated } = applyBudgetTruncation(filteredBlocks, effectiveBudget);

  // ── Step 6: 展平为消息列表 ──
  const messages: TaskMessage[] = [];
  for (const block of included) {
    for (const msg of block.messages) {
      messages.push({
        ...msg,
        isCurrentTurn: block === included[included.length - 1]
          && msg === block.messages[block.messages.length - 1],
      });
    }
  }

  const actualTokens = messages.reduce((sum, m) => sum + m.tokenCount, 0) + memoryMdTokens;

  return {
    ok: true,
    messages,
    totalTokens: actualTokens,
    memoryMdIncluded,
    taskBlockCount: included.length,
    filteredTaskBlockCount: timeWindowFilteredCount + truncated,
    rankedTaskBlocks: included,
    buildTimestamp: new Date().toISOString(),
    metadata: {
      rawTaskBlockCount,
      timeWindowFilteredCount,
      budgetTruncatedCount: truncated,
      targetBudget,
      actualTokens,
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
  TimeWindowFilterOptions,
} from './context-builder-types.js';
