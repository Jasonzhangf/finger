/**
 * MemPalace Search Adapter
 *
 * 调用 mempalace CLI 进行本地语义搜索
 * - FTS: 精确关键词匹配（~181ms）
 * - Embed: 语义相似度搜索（~108ms）
 * - Hybrid: FTS + Embed RRF 融合（~285ms）
 *
 * 无外部 API 依赖，完全本地运行
 */

import { exec } from 'child_process';
import * as util from 'util';
import { logger } from '../../../core/logger.js';
import { FINGER_PATHS } from '../../../core/finger-paths.js';

const log = logger.module('MemPalaceAdapter');

export interface MemPalaceSearchResult {
  id: string;
  content: string;
  score: number;
  source: string;
  wing: string;
  room: string;
}

export interface MemPalaceSearchOutput {
  ok: boolean;
  mode: 'fts' | 'embed' | 'hybrid';
  results: MemPalaceSearchResult[];
  latencyMs: number;
  error?: string;
}

export interface MemPalaceIndexOutput {
  ok: boolean;
  chunksIndexed: number;
  error?: string;
}

const DEFAULT_MEMPALACE_BIN = '/opt/homebrew/bin/mempalace';
const MEMPALACE_CWD = process.env.HOME || '/Users/fanzhang';
const DEFAULT_TOP_K = 12;
const DEFAULT_SEARCH_TIMEOUT_MS = 30000;

/**
 * 获取 mempalace binary 路径
 */
function getMemPalaceBin(): string {
  // 优先使用 ~/.finger/bin/mempalace（自定义编译版本，支持 --mode 参数）
  const customBin = `${FINGER_PATHS.home}/bin/mempalace`;
  // 否则使用系统安装版本
  try {
    if (require('fs').existsSync(customBin)) {
      return customBin;
    }
  } catch {
    // ignore
  }
  return DEFAULT_MEMPALACE_BIN;
}

/**
 * 执行 mempalace CLI 命令
 */
async function runMemPalace(args: string[], timeoutMs: number = DEFAULT_SEARCH_TIMEOUT_MS): Promise<string> {
  const bin = getMemPalaceBin();
  const cmd = `${bin} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  const execAsync = util.promisify(exec);
  
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      cwd: MEMPALACE_CWD,
      env: { ...process.env, HOME: process.env.HOME || '/Users/fanzhang' },
    });
    return stdout;
  } catch (err: unknown) {
    const execErr = err as { message?: string; stdout?: string; stderr?: string; code?: string };
    const stderr = execErr.stderr || '';
    
    // C3: Timeout → return empty results instead of throwing
    if (execErr.code === 'ETIMEDOUT' || (execErr.message && execErr.message.includes('timed out'))) {
      log.warn('[MemPalaceAdapter] Search timeout, returning empty results', {
        args,
        timeoutMs,
      });
      return ''; // Return empty stdout, will be handled by caller
    }
    
    // Other errors: still throw, but caller should handle gracefully
    throw new Error(`mempalace error: ${execErr.message || stderr}`);
  }
}

/**
 * 解析 mempalace search 输出
 */
function parseSearchOutput(output: string): MemPalaceSearchResult[] {
  const results: MemPalaceSearchResult[] = [];
  const lines = output.split('\n');

  let currentResult: MemPalaceSearchResult | null = null;
  let contentBuffer: string[] = [];

  for (const line of lines) {
    // 匹配格式: [N] wing/room
    const match = line.match(/^\s*\[(\d+)\]\s+(\S+)\/(\S+)/);
    if (match) {
      // 保存上一个结果
      if (currentResult) {
        currentResult.content = contentBuffer.join('\n').trim();
        results.push(currentResult);
      }
      // 开始新结果
      currentResult = {
        id: '', // 将在 Doc ID 行填充
        content: '',
        score: 0,
        source: '',
        wing: match[2],
        room: match[3],
      };
      contentBuffer = [];
    } else if (currentResult) {
      // 匹配 Doc ID: ...
      const docIdMatch = line.match(/^\s+Doc ID:\s+(.+)$/);
      if (docIdMatch) {
        currentResult.id = docIdMatch[1].trim();
      }
      // 匹配 Source: ...
      const sourceMatch = line.match(/^\s+Source:\s+(.+)$/);
      if (sourceMatch) {
        currentResult.source = sourceMatch[1].trim();
      }
      // 匹配 Score: ... (FTS 模式)
      const scoreMatch = line.match(/^\s+Score:\s+([\d.]+)$/);
      if (scoreMatch) {
        currentResult.score = parseFloat(scoreMatch[1]);
      }
      // 收集 content（非 header 行）
      if (line.trim() && !line.match(/^\s+Doc ID:/) && !line.match(/^\s+Source:/) && !line.match(/^\s+Score:/) && !line.match(/^\s+={5,}/) && !line.match(/^\s+-{5,}/) && !line.match(/^\s+Wing:/) && !line.match(/^\s+Mode:/) && !line.match(/^\s+Results for:/)) {
        contentBuffer.push(line.trim());
      }
      // 分隔符，结束当前结果
      if (line.trim().startsWith('---')) {
        currentResult.content = contentBuffer.join('\n').trim();
        results.push(currentResult);
        currentResult = null;
        contentBuffer = [];
      }
    }
  }

  // 保存最后一个结果
  if (currentResult) {
    currentResult.content = contentBuffer.join('\n').trim();
    results.push(currentResult);
  }

  return results;
}

/**
 * MemPalace 搜索
 */
export async function mempalaceSearch(
  query: string,
  options?: {
    wing?: string;
    mode?: 'fts' | 'embed' | 'hybrid';
    topK?: number;
    timeoutMs?: number;
  },
): Promise<MemPalaceSearchOutput> {
  const mode = options?.mode || 'embed';
  const wing = options?.wing || 'finger-ledger';
  const topK = options?.topK || DEFAULT_TOP_K;
  const timeoutMs = options?.timeoutMs || DEFAULT_SEARCH_TIMEOUT_MS;

  const start = Date.now();

  try {
    const args = [
      'search',
      query,
      '--wing', wing,
      '--mode', mode,
      '-n', String(topK),
    ];

    const output = await runMemPalace(args, timeoutMs);
    const results = parseSearchOutput(output);
    const latencyMs = Date.now() - start;

    return {
      ok: true,
      mode,
      results,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return {
      ok: false,
      mode,
      results: [],
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * MemPalace ledger 索引
 */
export async function mempalaceIndexLedger(
  ledgerPath: string,
  options?: {
    wing?: string;
    timeoutMs?: number;
  },
): Promise<MemPalaceIndexOutput> {
  const wing = options?.wing || 'finger-ledger';
  const timeoutMs = options?.timeoutMs || 600000; // 10 min for large ledger

  try {
    const args = [
      'ledger-index',
      ledgerPath,
      '--wing', wing,
    ];

    const output = await runMemPalace(args, timeoutMs);
    
    // 解析输出中的 chunks 数量
    const match = output.match(/Total indexed:\s*(\d+)\s*chunks/);
    const chunksIndexed = match ? parseInt(match[1], 10) : 0;

    return {
      ok: true,
      chunksIndexed,
    };
  } catch (err) {
    return {
      ok: false,
      chunksIndexed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 批量搜索多个 query
 */
export async function mempalaceBatchSearch(
  queries: string[],
  options?: {
    wing?: string;
    mode?: 'fts' | 'embed' | 'hybrid';
    topK?: number;
  },
): Promise<MemPalaceSearchOutput[]> {
  const results = await Promise.all(
    queries.map((q) => mempalaceSearch(q, options)),
  );
  return results;
}

/**
 * 合并多个搜索结果（去重）
 */
export function mergeSearchResults(
  searchResults: MemPalaceSearchOutput[],
): MemPalaceSearchResult[] {
  const merged = new Map<string, MemPalaceSearchResult>();

  for (const output of searchResults) {
    if (!output.ok) continue;
    for (const result of output.results) {
      const key = `${result.wing}/${result.room}/${result.id}`;
      if (!merged.has(key)) {
        merged.set(key, result);
      }
    }
  }

  return Array.from(merged.values());
}
