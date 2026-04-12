/**
 * MEMORY.md Writer — appends learning records to the ## Learnings section
 *
 * Provides:
 * - TypeScript equivalent of Rust kernel-evolution memory_writer
 * - Append learning records to project/system MEMORY.md
 * - Deduplication by dedup_key (tags + failures + goal)
 * - Auto-create ## Learnings section if not exists
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../../core/logger.js';
import type { LearningEntry } from './types.js';

const LEARNINGS_HEADER = '## Learnings';

/**
 * Compute dedup key for a learning entry (tags + failures + goal)
 * Sorts tags and failures for stable comparison
 */
export function computeDedupKey(entry: LearningEntry): string {
  const sortedTags = [...entry.tags].sort();
  const sortedFailures = [...entry.failures].sort();
  const goal = entry.successes.length > 0 ? entry.successes[0].slice(0, 50) : 'no-goal';
  return `${sortedTags.join(',')}|${sortedFailures.join(',')}|${goal}`;
}

/**
 * Extract existing dedup keys from MEMORY.md ## Learnings section
 * Looks for <!-- dedup:KEY --> HTML comment markers
 */
export function extractExistingKeys(content: string): string[] {
  const keys: string[] = [];
  const section = extractLearningsSection(content);
  for (const line of section.split('\n')) {
    const match = line.match(/^<!-- dedup:(.+?) -->$/);
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys;
}

/**
 * Extract the ## Learnings section content from MEMORY.md
 * Returns empty string if section not found
 */
export function extractLearningsSection(content: string): string {
  const startIdx = content.indexOf(LEARNINGS_HEADER);
  if (startIdx === -1) return '';

  const afterHeader = content.slice(startIdx + LEARNINGS_HEADER.length);
  const endIdx = afterHeader.indexOf('\n## ');
  return endIdx === -1 ? afterHeader : afterHeader.slice(0, endIdx);
}

/**
 * Format a learning entry as Markdown for MEMORY.md
 */
export function formatLearningEntry(entry: LearningEntry): string {
  const lines: string[] = [];
  const timestamp = entry.timestamp.toISOString();
  lines.push(`<!-- dedup:${computeDedupKey(entry)} -->`);
  lines.push(`### ${timestamp} [session:${entry.sessionId}]`);
  lines.push(`Goal: ${entry.tags.join(', ')}`);
  if (entry.successes.length > 0) {
    lines.push('Successes:');
    for (const s of entry.successes) {
      lines.push(`- ${s}`);
    }
  }
  if (entry.failures.length > 0) {
    lines.push('Failures:');
    for (const f of entry.failures) {
      lines.push(`- ${f}`);
    }
  }
  if (entry.toolUsage.length > 0) {
    lines.push('Tools:');
    for (const t of entry.toolUsage) {
      lines.push(`- ${t.tool}: ${t.status}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Append learning entries to a MEMORY.md file
 *
 * - Creates ## Learnings section if not exists
 * - Deduplicates against existing entries by dedup_key
 * - Returns number of entries actually appended
 */
export async function appendLearningsToMemory(
  memoryPath: string,
  entries: LearningEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;

  let content = '';
  try {
    content = await readFile(memoryPath, 'utf-8');
  } catch {
    // File not found, will create
    content = '';
  }

  const existingKeys = extractExistingKeys(content);
  const additions: string[] = [];
  let appended = 0;

  for (const entry of entries) {
    const key = computeDedupKey(entry);
    if (existingKeys.includes(key)) continue;
    additions.push(formatLearningEntry(entry));
    appended++;
  }

  if (appended === 0) return 0;

  const additionsText = additions.join('\n');
  let newContent: string;

  if (content.includes(LEARNINGS_HEADER)) {
    // Insert after header line
    const headerIdx = content.indexOf(LEARNINGS_HEADER);
    const afterHeader = headerIdx + LEARNINGS_HEADER.length;
    const nextNewline = content.slice(afterHeader).indexOf('\n');
    const insertPos = nextNewline === -1 ? content.length : afterHeader + nextNewline + 1;
    newContent = content.slice(0, insertPos) + additionsText + content.slice(insertPos);
  } else {
    // Create new section
    newContent = content.trimEnd() + '\n\n' + LEARNINGS_HEADER + '\n' + additionsText + '\n';
  }

  // Ensure parent directory exists
  await mkdir(dirname(memoryPath), { recursive: true });
  await writeFile(memoryPath, newContent, 'utf-8');

  logger.debug('MemoryWriter', `Appended ${appended} learning entries to ${memoryPath}`);
  return appended;
}

/**
 * Sync learning entry from reasoning.stop to project MEMORY.md
 * Called by event-forwarding after reasoning.stop succeeds
 */
export async function syncLearningToMemory(
  entry: LearningEntry,
  projectPath?: string,
): Promise<boolean> {
  const memoryPath = projectPath
    ? join(projectPath, 'MEMORY.md')
    : join(process.cwd(), 'MEMORY.md');

  try {
    const count = await appendLearningsToMemory(memoryPath, [entry]);
    return count > 0;
  } catch (err) {
    logger.warn('MemoryWriter', 'Failed to sync learning to MEMORY.md', {
      path: memoryPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
