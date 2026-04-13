/**
 * Context Rebuild with MemPalace
 *
 * 用 mempalace CLI（FTS + Embed + Hybrid）实现本地语义搜索重建上下文
 * 
 * 流程：
 * 1. 用户请求 → LLM 提取 tags + 意图分割
 * 2. tags → mempalace search（FTS + Embed 并行）
 * 3. 合并结果 → 去重 → 从 ledger 读取完整 content
 * 4. 按相关性排序 → LLM 重建上下文
 *
 * 基准测试结果（4877 chunks）：
 * - FTS: 181ms, 0.92 coverage
 * - Embed: 108ms, 0.92 coverage
 * - Hybrid: 285ms, 0.92 coverage
 */

import { join } from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { 
  mempalaceSearch, 
  mempalaceBatchSearch,
  mergeSearchResults,
  type MemPalaceSearchResult,
  type MemPalaceSearchOutput,
} from '../tools/internal/memory/mempalace-search-adapter.js';
import { readJsonLines } from './context-ledger-memory-helpers.js';
import type { LedgerEntryFile } from './context-ledger-memory-types.js';
import type { TaskBlock } from './context-builder-types.js';

export interface ContextRebuildInput {
  sessionId: string;
  agentId: string;
  prompt: string;
  tags?: string[];
  mode?: 'fts' | 'embed' | 'hybrid';
  topK?: number;
  maxTokens?: number;
}

export interface ContextRebuildOutput {
  ok: boolean;
  rankedBlocks: TaskBlock[];
  totalChunks: number;
  searchLatencyMs: number;
  rebuildLatencyMs: number;
  tagsUsed: string[];
  mode: 'fts' | 'embed' | 'hybrid';
  error?: string;
}

export interface ExtractedTags {
  keywords: string[];
  intent: string;
  topics: string[];
}

const DEFAULT_TOP_K = 12;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_MODE = 'embed';

/**
 * 从 prompt 提取 tags（简单分词 + 关键词提取）
 * TODO: 后续可用 LLM 做 intent 分割和 tag 提取
 */
export function extractTagsFromPrompt(prompt: string): ExtractedTags {
  // 简单分词（按空格、换行、标点分割）
  const words = prompt
    .toLowerCase()
    .split(/[\s\n\r,.!?;:()\\[\\]{}"'`]+/)
    .filter((w) => w.length >= 3 && !isStopWord(w));

  // 去重
  const uniqueWords = Array.from(new Set(words));

  // 选取前 5 个作为关键词
  const keywords = uniqueWords.slice(0, 5);

  // 提取可能的 topic（包含特定关键词的组合）
  const topics: string[] = [];
  
  // 检测技术术语
  const techTerms = ['heartbeat', 'ledger', 'session', 'context', 'mempalace', 'hypatia', 'compact', 'embedding', 'fts', 'hybrid'];
  for (const term of techTerms) {
    if (prompt.toLowerCase().includes(term)) {
      topics.push(term);
    }
  }

  // intent 从 prompt 长度和内容��断
  const intent = prompt.length > 100 ? 'complex_query' : 'simple_query';

  return {
    keywords,
    intent,
    topics,
  };
}

function isStopWord(word: string): boolean {
  const stopWords = ['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
    'through', 'during', 'before', 'after', 'above', 'below', 'between', 'under',
    'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
    'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'and', 'but', 'if', 'or', 'because', 'until', 'while', 'although', 'though',
    'after', 'before', 'when', 'whenever', 'where', 'wherever', 'whether', 'which',
    'that', 'this', 'these', 'those', 'what', 'who', 'whom', 'whose', 'why'];
  return stopWords.includes(word);
}

/**
 * 解析 ledger 路径
 */
function resolveLedgerPath(sessionId: string, agentId: string): string {
  // 判断是否是 system session
  if (sessionId.startsWith('hb-session') || sessionId.startsWith('system-')) {
    return join(FINGER_PATHS.home, 'system', 'sessions', sessionId, agentId, 'main', 'context-ledger.jsonl');
  }
  return join(FINGER_PATHS.sessions.dir, sessionId, agentId, 'main', 'context-ledger.jsonl');
}

/**
 * 从 ledger 读取完整 content
 */
async function fetchLedgerContent(
  sessionId: string,
  agentId: string,
  chunkIds: string[],
): Promise<Map<string, string>> {
  const ledgerPath = resolveLedgerPath(sessionId, agentId);
  const contentMap = new Map<string, string>();

  try {
    const entries = await readJsonLines<LedgerEntryFile>(ledgerPath);
    
    // 根据 chunk id 匹配 content
    // chunk id 格式: ledger-{wing}-{index}
    for (const chunkId of chunkIds) {
      const match = chunkId.match(/ledger-(\\w+)-(\\d+)/);
      if (match) {
        const index = parseInt(match[2], 10);
        if (index >= 0 && index < entries.length) {
          const entry = entries[index];
          const content = extractContentFromEntry(entry);
          contentMap.set(chunkId, content);
        }
      }
    }
  } catch (err) {
    // 读取失败时返回空 map
  }

  return contentMap;
}

/**
 * 从 ledger entry 提取 content
/**
 * Ledger payload 类型（简化版）
 */
interface LedgerPayload {
  reasoning_trace?: string[];
  content?: string;
  tool_name?: string;
  input?: unknown;
  role?: string;
}

/**
 * 从 ledger entry 提取 content
 */
function extractContentFromEntry(entry: LedgerEntryFile): string {
  const payload = entry.payload as LedgerPayload;
  // reasoning_trace
  if (payload?.reasoning_trace) {
    const traces = payload.reasoning_trace;
    return traces.join('\n');
  }
  // session_message content
  if (payload?.content) {
    return payload.content;
  }
  // tool_call
  if (payload?.tool_name) {
    return `调用工具: ${payload.tool_name}\n输入: ${JSON.stringify(payload.input)}`;
  }
  return '';
}


/**
 * 将搜索结果转换为 TaskBlock
 */
function searchResultsToBlocks(
  results: MemPalaceSearchResult[],
  contentMap: Map<string, string>,
): TaskBlock[] {
  const blocks: TaskBlock[] = [];

  for (const result of results) {
    // 优先使用 contentMap（从 ledger fetch），否则使用 mempalace 返回的 preview content
    const content = contentMap.get(result.id) || result.content || '';
    if (content.length > 0) {
      blocks.push({
        id: result.id,
        startTime: Date.now(),
        endTime: Date.now(),
        startTimeIso: new Date().toISOString(),
        endTimeIso: new Date().toISOString(),
        messages: [{
          id: result.id,
          role: 'assistant',
          content,
          timestamp: Date.now(),
          timestampIso: new Date().toISOString(),
          tokenCount: estimateTokenCount(content),
        }],
        tokenCount: estimateTokenCount(content),
        relevanceScore: result.score,
        tags: [result.source],
        topic: result.room,
      });
    }
  }

  return blocks;
}

/**
 * 估算 token 数量（简单按字符数）
 */
function estimateTokenCount(text: string): number {
  // 简单估算：英文 4 字符 ≈ 1 token，中文 1 字符 ≈ 2 token
  const chineseCount = (text.match(/[\\u4e00-\\u9fa5]/g) || []).length;
  const otherCount = text.length - chineseCount;
  return Math.ceil(chineseCount * 2 + otherCount / 4);
}

/**
 * Context Rebuild 主函数
 */
export async function runContextRebuildWithMemPalace(
  input: ContextRebuildInput,
): Promise<ContextRebuildOutput> {
  const start = Date.now();
  const mode = input.mode || DEFAULT_MODE;
  const topK = input.topK || DEFAULT_TOP_K;
  const maxTokens = input.maxTokens || DEFAULT_MAX_TOKENS;

  try {
    // 1. 提取 tags
    const extractedTags = extractTagsFromPrompt(input.prompt);
    const tags = input.tags || [...extractedTags.keywords, ...extractedTags.topics];

    if (tags.length === 0) {
      return {
        ok: false,
        rankedBlocks: [],
        totalChunks: 0,
        searchLatencyMs: 0,
        rebuildLatencyMs: Date.now() - start,
        tagsUsed: [],
        mode,
        error: 'no_tags_extracted',
      };
    }

    // 2. 执行搜索
    const searchStart = Date.now();
    
    let mergedResults: MemPalaceSearchResult[] = [];
    
    if (mode === 'hybrid') {
      // Hybrid: 并行执行 FTS 和 Embed 搜索，然后 RRF 融合
      const [ftsResults, embedResults] = await Promise.all([
        mempalaceBatchSearch(tags, { wing: 'finger-ledger', mode: 'fts', topK }),
        mempalaceBatchSearch(tags, { wing: 'finger-ledger', mode: 'embed', topK }),
      ]);
      mergedResults = mergeSearchResults([...ftsResults, ...embedResults]);
    } else if (mode === 'fts') {
      // 纯 FTS
      const ftsResults = await mempalaceBatchSearch(tags, { wing: 'finger-ledger', mode: 'fts', topK });
      mergedResults = mergeSearchResults(ftsResults);
    } else {
      // 纯 Embed (默认)
      const embedResults = await mempalaceBatchSearch(tags, { wing: 'finger-ledger', mode: 'embed', topK });
      mergedResults = mergeSearchResults(embedResults);
    }

    const searchLatencyMs = Date.now() - searchStart;

    // 4. 从 ledger 读取完整 content
    const chunkIds = mergedResults.map((r) => r.id);
    const contentMap = await fetchLedgerContent(input.sessionId, input.agentId, chunkIds);

    // 5. 转换为 TaskBlock
    const blocks = searchResultsToBlocks(mergedResults, contentMap);

    // 6. 按 relevance 排序 + token budget 控制
    const rankedBlocks = blocks
      .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
      .slice(0, maxTokens / 200); // 简单按 token 估算

    const rebuildLatencyMs = Date.now() - start;

    return {
      ok: true,
      rankedBlocks,
      totalChunks: mergedResults.length,
      searchLatencyMs,
      rebuildLatencyMs,
      tagsUsed: tags,
      mode,
    };
  } catch (err) {
    return {
      ok: false,
      rankedBlocks: [],
      totalChunks: 0,
      searchLatencyMs: 0,
      rebuildLatencyMs: Date.now() - start,
      tagsUsed: [],
      mode,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 快速 context rebuild（只用 Embed 模式）
 */
export async function quickContextRebuild(
  sessionId: string,
  agentId: string,
  prompt: string,
): Promise<ContextRebuildOutput> {
  return runContextRebuildWithMemPalace({
    sessionId,
    agentId,
    prompt,
    mode: 'embed',
    topK: 8,
    maxTokens: 4000,
  });
}
