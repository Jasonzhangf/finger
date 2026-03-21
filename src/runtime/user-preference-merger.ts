/**
 * User Preference Merger - 合并用户偏好 patch 到 USER.md
 *
 * 设计原则：
 * 1. 从 compact-memory.jsonl 读取 user_preference_patch 字段
 * 2. 合并生成新的 USER.md（保留历史）
 * 3. 每日 00:00 定时任务调用
 * 4. 保留 USER-history.jsonl 作为历史记录
 */

import { promises as fs } from 'fs';
import path from 'path';
import { resolveCompactMemoryPath, readJsonLines } from './context-ledger-memory-helpers.js';
import type { CompactMemoryEntryFile } from './context-ledger-memory-types.js';

export interface MergeResult {
  /** Number of patches merged */
  patchCount: number;
  /** Whether USER.md was modified */
  modified: boolean;
  /** The new USER.md content (if modified) */
  newContent?: string;
}

export interface MergeOptions {
  /** Root dir for session storage */
  rootDir?: string;
  /** Agent ID */
  agentId?: string;
  /** Session ID */
  sessionId?: string;
  /** Mode */
  mode?: string;
  /**
   * Custom merger function.
   * When provided, called with current USER.md content + patches to produce merged content.
   * When omitted, uses simple concatenation.
   */
  merger?: (currentContent: string, patches: string[]) => Promise<string>;
}

/**
 * Extract user_preference_patch values from compact-memory.jsonl entries.
 * Returns patches in chronological order.
 */
export async function extractUserPreferencePatches(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
): Promise<string[]> {
  const compactPath = resolveCompactMemoryPath(rootDir, sessionId, agentId, mode);
  const entries = await readJsonLines<CompactMemoryEntryFile>(compactPath);

  const patches: string[] = [];
  for (const entry of entries) {
    const payload = entry.payload as Record<string, unknown>;
    if (
      typeof payload.user_preference_patch === 'string'
      && payload.user_preference_patch.trim().length > 0
    ) {
      patches.push(payload.user_preference_patch.trim());
    }
  }

  return patches;
}

/**
 * Default merger: appends patches as a new section to USER.md.
 */
async function defaultMerger(currentContent: string, patches: string[]): Promise<string> {
  if (patches.length === 0) return currentContent;

  const timestamp = new Date().toISOString();
  const patchSection = patches
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  const newSection = `\n\n---\n## Preferences Update (${timestamp})\n\n${patchSection}\n`;

  return currentContent + newSection;
}

/**
 * Read USER.md content.
 */
export async function readUserMd(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write USER.md content with history backup.
 */
export async function writeUserMdWithHistory(
  filePath: string,
  newContent: string,
  historyDir?: string,
): Promise<void> {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // Backup current content to history
  const histDir = historyDir || path.join(dir, 'history');
  if (await fs.access(filePath).then(() => true).catch(() => false)) {
    await fs.mkdir(histDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const histPath = path.join(histDir, `USER-${date}.md`);
    const existing = await readUserMd(histPath);
    const current = await readUserMd(filePath);
    // Only write history if content changed
    if (existing !== current) {
      await fs.writeFile(histPath, current, 'utf-8');
    }
  }

  await fs.writeFile(filePath, newContent, 'utf-8');
}

/**
 * Merge user preference patches into USER.md.
 *
 * @param userMdPath Path to USER.md
 * @param patches Array of user_preference_patch strings
 * @param options Merge options
 * @returns MergeResult with patch count and modification status
 */
export async function mergeUserPreferences(
  userMdPath: string,
  patches: string[],
  options: MergeOptions = {},
): Promise<MergeResult> {
  if (patches.length === 0) {
    return { patchCount: 0, modified: false };
  }

  // Filter out empty patches
  const validPatches = patches.filter(p => p.trim().length > 0);
  if (validPatches.length === 0) {
    return { patchCount: patches.length, modified: false };
  }

  const currentContent = await readUserMd(userMdPath);
  const mergerFn = options.merger || defaultMerger;
  const newContent = await mergerFn(currentContent, validPatches);

  if (newContent === currentContent) {
    return { patchCount: validPatches.length, modified: false };
  }

  const historyDir = options.rootDir
    ? path.join(options.rootDir, 'user-preference-history')
    : undefined;

  await writeUserMdWithHistory(userMdPath, newContent, historyDir);

  return {
    patchCount: validPatches.length,
    modified: true,
    newContent,
  };
}
