/**
 * Context Builder - 动态上下文构建器
 *
 * 职责：
 * 1. 读取 MEMORY.md 作为强制性长期记忆上下文
 * 2. 从运行时 session 快照或 Ledger 读取历史记录（默认优先 session 快照）
 * 3. 24小时半衰期时间窗口过滤
 * 4. 任务边界分组（一次完整用户请求 = 一个 task）
 * 5. 模型辅助排序（可选）
 * 6. 预算控制组装上下文
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
import { getAIProvider, getContextWindow } from '../core/user-settings.js';
import {
  readJsonLines,
  normalizeRootDir,
  resolveLedgerPath,
} from './context-ledger-memory-helpers.js';
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
  TimeWindowFilterOptions,
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

// ── 常量 ──────────────────────────────────────────────────────────────

const DEFAULT_HALF_LIFE_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_OVER_THRESHOLD_RELEVANCE = 0.5; // 超过24h后相关性阈值
const DEFAULT_BUDGET_RATIO = 0.85; // 目标上下文占模型窗口的比例
const log = logger.module('ContextBuilder');

function normalizeTaskMessageRole(input: unknown): TaskMessage['role'] {
  if (input === 'assistant' || input === 'system' || input === 'orchestrator' || input === 'user') {
    return input;
  }
  return 'user';
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

    const msg: TaskMessage = {
      id: entry.id,
      role,
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
  const blocks: TaskBlock[] = [];
  let currentBlock: TaskMessage[] = [];
  let blockStartTs = normalized[0].timestamp;
  let blockId = `task-${normalized[0].timestamp}`;

  for (const msg of normalized) {
    if (msg.role === 'user' && currentBlock.length > 0) {
      blocks.push(finalizeBlock(blockId, blockStartTs, currentBlock));
      blockStartTs = msg.timestamp;
      blockId = `task-${msg.timestamp}`;
      currentBlock = [msg];
    } else {
      currentBlock.push(msg);
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
  const providerId = (params.providerId || '').trim();
  if (!providerId) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false, reason: 'missing_provider_id' };
  }
  const provider = getAIProvider(providerId);
  if (!provider) {
    return { rankedTaskIds: blocks.map((b) => b.id), executed: false, reason: 'provider_not_found' };
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
              params.currentPrompt || '（无）',
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
      return {
        rankedTaskIds: blocks.map((b) => b.id),
        providerId,
        providerModel: provider.model,
        executed: false,
        reason: `http_${response.status}`,
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

function summarizeTaskBlock(block: TaskBlock): string | undefined {
  const firstUser = block.messages.find((message) => message.role === 'user')?.content?.trim() ?? '';
  if (firstUser.length === 0) return undefined;
  const normalized = firstUser.replace(/\s+/g, ' ');
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 120)}...`;
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
  const enableTaskGrouping = options?.enableTaskGrouping !== false;

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

  const rawTaskBlockCount = rawBlocks.length;

  // ── Step 3: 时间窗口过滤 ──
  let filteredBlocks = rawBlocks;
  let timeWindowFilteredCount = 0;
  if (options?.timeWindow) {
    filteredBlocks = applyTimeWindowFilter(rawBlocks, options.timeWindow);
    timeWindowFilteredCount = rawBlocks.length - filteredBlocks.length;
  }
  const { current, historical } = splitCurrentAndHistorical(filteredBlocks);
  let rankedHistorical = historical;

  // ── Step 3.5: embedding recall（历史候选召回） ──
  const embeddingRecallEnabled = options?.enableEmbeddingRecall !== false;
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

  // ── Step 4: 可选模型排序（active/dryrun） ──
  const rankingMode = resolveRankingMode(options?.enableModelRanking);
  let rankingExecuted = false;
  let rankingProviderId: string | undefined;
  let rankingProviderModel: string | undefined;
  let rankingReason: string | undefined;
  let rankingIds: string[] | undefined;
  if ((rankingMode === 'active' || rankingMode === 'dryrun') && rankedHistorical.length > 0) {
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

  if (current) {
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
  const { included, truncated } = applyBudgetTruncation(filteredBlocks, effectiveBudget);
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
  const workingSetBlocks = included.filter((block) => block.id === workingSetBlockId);
  const historicalBlocksIncluded = included.filter((block) => block.id !== workingSetBlockId);
  for (const block of included) {
    const contextZone: ContextMessageZone = block.id === workingSetBlockId ? 'working_set' : 'historical_memory';
    for (const msg of block.messages) {
      messages.push({
        ...msg,
        contextZone,
        isCurrentTurn: block === included[included.length - 1]
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
    buildMode,
    targetBudget,
    actualTokens,
    rawTaskBlockCount,
    selectedTaskBlockCount: included.length,
    rankingMode,
    rankingExecuted,
    rankingReason: rankingReason ?? 'not_requested',
    rankingProviderId,
    rankingProviderModel,
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
    taskBlockCount: included.length,
    filteredTaskBlockCount: timeWindowFilteredCount + truncated,
    rankedTaskBlocks: included,
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
      embeddingRecallExecuted,
      embeddingCandidateCount,
      ...(embeddingRecallReason ? { embeddingRecallReason } : {}),
      ...(embeddingIndexPath ? { embeddingIndexPath } : {}),
      ...(embeddingRecallError ? { embeddingRecallError } : {}),
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
  TimeWindowFilterOptions,
} from './context-builder-types.js';
