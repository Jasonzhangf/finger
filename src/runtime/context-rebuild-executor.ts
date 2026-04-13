/**
 * Context Rebuild Executor — 执行上下文重建的核心逻辑
 * 
 * 基于 MemPalace 语义搜索，从 ledger 中检索相关内容重建上下文
 */

import { mempalaceSearch, MemPalaceSearchResult } from '../tools/internal/memory/mempalace-search-adapter.js';
import { logger } from '../core/logger.js';
import { isHeartbeatSession } from './topic-shift-detector.js';

const log = logger.module('ContextRebuildExecutor');

export interface ContextRebuildOptions {
  mode?: 'fts' | 'embed' | 'hybrid';
  topK?: number;
  maxTokens?: number;
  /** 心跳 session 专用：排除系统提示词干扰 */
  excludeSystemPrompt?: boolean;
}

export interface ContextRebuildResult {
  ok: boolean;
  rankedBlocks: TaskBlock[];
  totalChunks: number;
  latencyMs: number;
  tokensUsed?: number;
  error?: string;
}

interface TaskBlock {
  id: string;
  startTime: number;
  endTime: number;
  startTimeIso: string;
  endTimeIso: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    timestampIso: string;
    tokenCount: number;
  }>;
  tokenCount: number;
  relevanceScore: number;
  tags: string[];
  topic?: string;
}

/** 需要排除的系统提示词关键词 */
const SYSTEM_PROMPT_KEYWORDS = [
  'system_prompt',
  'system_instruction',
  '你是',
  '作为',
  'assistant',
  'finger-system-agent',
  'role: system',
  '## 角色',
  '## 任务',
  '你的职责',
];

/**
 * 估算消息的 token 数量（简单估算：每 4 字符 ~1 token）
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 判断内容是否为系统提示词（心跳 session 需要排除）
 */
function isSystemPromptContent(content: string, source: string): boolean {
  // 1. 检查 source 是否来自 system agent
  if (source.includes('system') || source.includes('finger-system-agent')) {
    return true;
  }
  
  // 2. 检查内容是否包含系统提示词关键词
  const lowerContent = content.toLowerCase();
  for (const kw of SYSTEM_PROMPT_KEYWORDS) {
    if (lowerContent.includes(kw.toLowerCase())) {
      // 需要进一步判断：如果内容长度 < 200，可能是简短的系统消息，保留
      // 如果内容长度 > 500 且包含系统提示词关键词，很可能是系统 prompt
      if (content.length > 300) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * 从 mempalace 搜索结果构建 TaskBlock
 */
function searchResultsToBlocks(
  results: MemPalaceSearchResult[],
  excludeSystemPrompt: boolean,
): TaskBlock[] {
  return results
    .filter((r) => {
      // 心跳 session：排除系统提示词干扰
      if (excludeSystemPrompt && isSystemPromptContent(r.content, r.source)) {
        log.debug('Filtering out system prompt content', {
          id: r.id,
          source: r.source,
          contentLength: r.content.length,
        });
        return false;
      }
      return true;
    })
    .map((r, i) => {
      const tokenCount = estimateTokenCount(r.content);
      return {
        id: r.id,
        startTime: Date.now(),
        endTime: Date.now(),
        startTimeIso: new Date().toISOString(),
        endTimeIso: new Date().toISOString(),
        messages: [{
          id: r.id,
          role: 'assistant',
          content: r.content,
          timestamp: Date.now(),
          timestampIso: new Date().toISOString(),
          tokenCount,
        }],
        tokenCount,
        relevanceScore: 1 - (i / results.length),
        tags: [r.source],
        topic: r.room,
      };
    });
}

/**
 * 执行上下文重建
 */
export async function executeContextRebuild(
  sessionId: string,
  agentId: string,
  prompt: string,
  options: ContextRebuildOptions = {},
): Promise<ContextRebuildResult> {
  const startTime = Date.now();
  const mode = options.mode || 'embed';
  const topK = options.topK || 12;
  const maxTokens = options.maxTokens || 8000;
  const excludeSystemPrompt = options.excludeSystemPrompt || false;

  try {
    log.debug('Executing context rebuild', {
      sessionId,
      agentId,
      prompt: prompt.substring(0, 50),
      mode,
      topK,
      maxTokens,
      excludeSystemPrompt,
    });

    // 1. 执行 mempalace 搜索（直接 tokenize，无需 LLM）
    const searchResult = await mempalaceSearch(prompt, {
      wing: 'finger-ledger',
      mode,
      topK,
    });

    // 2. 搜索失败处理
    if (!searchResult.ok || searchResult.results.length === 0) {
      log.warn('Context rebuild search returned no results', {
        sessionId,
        prompt: prompt.substring(0, 50),
        latency: searchResult.latencyMs,
      });
      return {
        ok: false,
        rankedBlocks: [],
        totalChunks: 0,
        latencyMs: Date.now() - startTime,
        error: 'search_no_results',
      };
    }

    // 3. 超时处理
    if (searchResult.latencyMs > 500) {
      log.warn('Context rebuild search timeout', {
        sessionId,
        latency: searchResult.latencyMs,
      });
    }

    // 4. 将搜索结果转换为 TaskBlock（过滤系统提示词）
    const blocks = searchResultsToBlocks(searchResult.results, excludeSystemPrompt);

    // 5. 如果过滤后结果为空
    if (blocks.length === 0) {
      log.warn('Context rebuild: all results filtered out', {
        sessionId,
        originalCount: searchResult.results.length,
        excludeSystemPrompt,
      });
      return {
        ok: false,
        rankedBlocks: [],
        totalChunks: searchResult.results.length,
        latencyMs: Date.now() - startTime,
        error: 'all_filtered',
      };
    }

    // 6. Token budget 控制
    let totalTokens = 0;
    const selectedBlocks: TaskBlock[] = [];

    for (const block of blocks) {
      if (totalTokens + block.tokenCount <= maxTokens) {
        selectedBlocks.push(block);
        totalTokens += block.tokenCount;
      } else {
        break;
      }
    }

    log.info('Context rebuild complete', {
      sessionId,
      totalChunks: searchResult.results.length,
      filteredChunks: searchResult.results.length - blocks.length,
      selectedBlocks: selectedBlocks.length,
      tokensUsed: totalTokens,
      latencyMs: Date.now() - startTime,
      excludeSystemPrompt,
    });

    return {
      ok: true,
      rankedBlocks: selectedBlocks,
      totalChunks: searchResult.results.length,
      latencyMs: Date.now() - startTime,
      tokensUsed: totalTokens,
    };

  } catch (err) {
    const execError = err instanceof Error ? err : new Error(String(err));
    log.error('Context rebuild execution failed', execError, { sessionId });

    return {
      ok: false,
      rankedBlocks: [],
      totalChunks: 0,
      latencyMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 从 payload 中提取 prompt 文本
 */
export function extractPromptFromPayload(input: Record<string, unknown>): string | null {
  const promptFields = ['prompt', 'query', 'input', 'text', 'content', 'message'];
  
  for (const field of promptFields) {
    const value = input[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  
  return null;
}

/**
 * 估算消息 token 数量（用于 session messages）
 */
export function estimateMessageTokens(message: { content: string }): number {
  return estimateTokenCount(message.content);
}

/**
 * 从 session messages 中提取最近 N 轮 task.digest
 * 用于普通用户请求的 working set（最近三轮）
 */
export function extractRecentTaskDigests(
  messages: Array<{ role: string; content: string }>,
  roundCount: number,
): Array<{ role: string; content: string }> {
  // 提取最近的 user-assistant 对话对（一轮）
  const rounds: Array<Array<{ role: string; content: string }>> = [];
  let currentRound: Array<{ role: string; content: string }> = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (currentRound.length > 0) {
        rounds.push(currentRound);
      }
      currentRound = [{ role: msg.role, content: msg.content }];
    } else if (msg.role === 'assistant' && currentRound.length > 0) {
      currentRound.push({ role: msg.role, content: msg.content });
      // 一轮完成，检查是否达到需要的轮数
    } else if (msg.role === 'system' && currentRound.length === 0) {
      // 跳过 system 消息
      continue;
    }
  }

  // 添加最后一轮（如果未完成）
  if (currentRound.length > 0) {
    rounds.push(currentRound);
  }

  // 取最近 N 轮
  const recentRounds = rounds.slice(-roundCount);
  return recentRounds.flat();
}
