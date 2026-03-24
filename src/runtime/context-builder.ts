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
import { getAIProvider, getContextWindow } from '../core/user-settings.js';
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
  RankingOutput,
} from './context-builder-types.js';

type AttachmentPlaceholder = {
  count: number;
  summary: string;
};

// ── 常量 ──────────────────────────────────────────────────────────────

const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_OVER_THRESHOLD_RELEVANCE = 0.5; // 超过24h后相关性阈值
const DEFAULT_BUDGET_RATIO = 0.85; // 目标上下文占模型窗口的比例

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
    const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata as Record<string, unknown>
      : undefined;
    const messageId = typeof payload.message_id === 'string' ? payload.message_id : undefined;
    const attachments = compactAttachments(payload.attachments);
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
      messageId,
      metadata,
      attachments,
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

type RankingMode = 'off' | 'active' | 'dryrun';

function resolveRankingMode(flag: ContextBuildOptions['enableModelRanking'] | undefined): RankingMode {
  if (flag === 'dryrun') return 'dryrun';
  if (flag === true) return 'active';
  return 'off';
}

async function runModelRanking(
  blocks: TaskBlock[],
  params: {
    providerId?: string;
    currentPrompt?: string;
  },
): Promise<{ rankedTaskIds: string[]; providerId?: string; providerModel?: string; executed: boolean }> {
  if (blocks.length <= 1) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false };
  }
  const providerId = (params.providerId || '').trim();
  if (!providerId) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false };
  }
  const provider = getAIProvider(providerId);
  if (!provider) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false };
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
              '任务：根据用户当前的输入意图，在历史对话任务中找到相关的执行记录，按「内容相关性优先，时间次之」的原则排序。',
              '',
              '排序原则（双重维度）：',
              '',
              '一、内容相关性（首要维度）',
              '- 高相关：task 直接涉及当前问题的话题/文件/概念',
              '- 中相关：task 与当前问题有间接关联（相关领域、依赖模块等）',
              '- 低相关：task 与当前问题无明显关联',
              '',
              '二、时间相关性（次要维度）',
              '- 在相同内容相关性级别内，时间更近的 task 排在前面',
              '- 最近的任���优先级更高，因为上下文更连贯',
              '',
              '最终排序：高相关(时间倒序) → 中相关(时间倒序) → 低相关(时间倒序)',
              '',
              '判断内容相关性的依据：',
              '1. 话题匹配：task 讨论/解决的问题与当前问题是否同类',
              '2. 文件匹配：task 操作的文件/目录是否与当前问题相关',
              '3. 概念匹配：task 涉及的技术概念/术语是否与当前问题相关',
              '4. 结论复用：task 的结论/结果是否对解决当前问题有帮助',
              '',
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
              params.currentPrompt || '（无）',
              '',
              '【历史任务候选】',
              '以下是与用户当前会话相关的历史任务记录，请根据相关性排序：',
              '',
              blocks.map((b) => {
                const userMsg = b.messages.find((m) => m.role === 'user');
                const assistantMsgs = b.messages.filter((m) => m.role === 'assistant');
                const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
                const preview = [
                  `[${b.id}]`,
                  `时间: ${b.startTimeIso}`,
                  userMsg ? `用户: ${userMsg.content.slice(0, 300)}` : '',
                  lastAssistant ? `助手: ${lastAssistant.content.slice(0, 500)}` : '',
                ].filter(Boolean).join('\n');
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
    const endpoint = provider.base_url.endsWith('/')
      ? `${provider.base_url}responses`
      : `${provider.base_url}/responses`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { rankedTaskIds: blocks.map((b) => b.id), providerId, providerModel: provider.model, executed: false };
    }
    const data = await response.json() as Record<string, unknown>;
    const outputText = extractResponseOutputText(data);
    if (!outputText) {
      return { rankedTaskIds: blocks.map((b) => b.id), providerId, providerModel: provider.model, executed: false };
    }
    const parsed = tryParseRankingOutput(outputText);
    if (!parsed) {
      return { rankedTaskIds: blocks.map((b) => b.id), providerId, providerModel: provider.model, executed: false };
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
    };
  } catch {
    return { rankedTaskIds: blocks.map((b) => b.id), providerId, providerModel: provider.model, executed: false };
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
      messageId: typeof payload.message_id === 'string' ? payload.message_id : undefined,
      metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown>
        : undefined,
      attachments: compactAttachments(payload.attachments),
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

  // ── Step 4: 可选模型排序（active/dryrun） ──
  const rankingMode = resolveRankingMode(options?.enableModelRanking);
  let rankingExecuted = false;
  let rankingProviderId: string | undefined;
  let rankingProviderModel: string | undefined;
  let rankingIds: string[] | undefined;
  if (rankingMode === 'active' || rankingMode === 'dryrun') {
    const ranking = await runModelRanking(filteredBlocks, {
      providerId: options?.rankingProviderId,
      currentPrompt: input.currentPrompt,
    });
    rankingExecuted = ranking.executed;
    rankingProviderId = ranking.providerId;
    rankingProviderModel = ranking.providerModel;
    rankingIds = ranking.rankedTaskIds;

    if (rankingMode === 'active' && ranking.executed) {
      filteredBlocks = reorderBlocksByRanking(filteredBlocks, ranking.rankedTaskIds);
    }
  }

  // ── Step 5: MEMORY.md 预算预留 ──
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

  // ── Step 6: 预算截断 ──
  const { included, truncated } = applyBudgetTruncation(filteredBlocks, effectiveBudget);

  // ── Step 7: 展平为消息列表 ──
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
      rankingExecuted,
      rankingMode,
      ...(rankingProviderId ? { rankingProviderId } : {}),
      ...(rankingProviderModel ? { rankingProviderModel } : {}),
      ...(rankingIds ? { rankingIds } : {}),
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
