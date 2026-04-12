/**
 * Mempalace Bridge for Insights Engine
 * Sync learnings to mempalace for semantic indexing
 */

import { logger } from '../../core/logger.js';
import { spawn } from 'child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import type { LearningEntry } from './types.js';

const MEMPALACE_CLI_PATH = '/opt/homebrew/bin/mempalace';

export interface MempalaceDocument {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface MempalaceClusterResult {
  clusterId: string;
  centroidContent: string;
  members: string[];
  score: number;
}

/**
 * Check if mempalace CLI is available
 */
export function isMempalaceAvailable(): boolean {
  return existsSync(MEMPALACE_CLI_PATH);
}

/**
 * Execute mempalace CLI command
 */
async function executeMempalace(
  args: string[],
  timeoutMs: number = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(MEMPALACE_CLI_PATH, args, {
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    proc.on('error', (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

/**
 * Format learning entry as searchable markdown
 */
export function formatLearningContent(entry: LearningEntry): string {
  const lines: string[] = [
    '# Learning ' + entry.timestamp.toISOString(),
    'Session: ' + entry.sessionId,
    '',
    '## Successes',
    ...entry.successes.map((s) => '- ' + s),
    '',
    '## Failures',
    ...entry.failures.map((f) => '- ' + f),
    '',
    '## Tags',
    ...entry.tags.map((t) => '- ' + t),
    '',
    '## Tool Usage',
    ...entry.toolUsage.map((u) => '- ' + u.tool + ': ' + u.status),
  ];
  return lines.join('\n');
}

/**
 * Build a MempalaceDocument from a LearningEntry
 * Used for testing and document preparation before sync
 */
export function buildMempalaceDocument(entry: LearningEntry): MempalaceDocument {
  return {
    id: 'learning-' + entry.sessionId + '-' + entry.timestamp.getTime(),
    content: formatLearningContent(entry),
    metadata: {
      type: 'learning',
      sessionId: entry.sessionId,
      timestamp: entry.timestamp.toISOString(),
      tags: entry.tags,
      successCount: entry.successes.length,
      failureCount: entry.failures.length,
    },
  };
}

/**
 * Sync a learning entry to mempalace for semantic indexing
 */
export async function syncLearningToMempalace(
  entry: LearningEntry,
  wing: string = 'finger-evolution',
  room: string = 'learnings'
): Promise<boolean> {
  if (!isMempalaceAvailable()) {
    logger.warn('InsightsEngine', 'mempalace CLI not available, skipping sync');
    return false;
  }

  const drawer = 'learning-' + entry.sessionId + '-' + entry.timestamp.getTime();
  const content = formatLearningContent(entry);
  const tmpPath = '/tmp/finger-learning-' + entry.timestamp.getTime() + '.md';

  try {
    writeFileSync(tmpPath, content);
    const args = ['mine', '--wing', wing, '--room', room, '--drawer', drawer, tmpPath];
    const result = await executeMempalace(args, 10_000);
    unlinkSync(tmpPath);

    if (result.exitCode === 0) {
      logger.debug('InsightsEngine', 'Synced learning to mempalace: ' + drawer);
      return true;
    } else {
      logger.warn('InsightsEngine', 'mempalace mine failed: ' + result.stderr);
      return false;
    }
  } catch (err) {
    logger.error('InsightsEngine', 'Failed to sync learning to mempalace: ' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

/**
 * Search for similar failures in mempalace
 */
export async function searchSimilarFailures(
  queryText: string,
  wing: string = 'finger-evolution',
  room: string = 'learnings',
  limit: number = 5
): Promise<MempalaceClusterResult[]> {
  if (!isMempalaceAvailable()) {
    return [];
  }

  const args = ['search', '--wing', wing, '--room', room, '--query', queryText, '--limit', String(limit), '--json'];
  const result = await executeMempalace(args, 15_000);

  if (result.exitCode !== 0) {
    logger.warn('InsightsEngine', 'mempalace search failed: ' + result.stderr);
    return [];
  }

  return parseMempalaceSearchOutput(result.stdout);
}

/**
 * Parse mempalace search output (JSON or text)
 */
function parseMempalaceSearchOutput(rawOutput: string): MempalaceClusterResult[] {
  const results: MempalaceClusterResult[] = [];

  try {
    const parsed = JSON.parse(rawOutput);
    if (Array.isArray(parsed)) {
      return parsed.map((item, idx) => ({
        clusterId: item.id ?? String(idx),
        centroidContent: item.content ?? item.text ?? '',
        members: [item.drawer ?? String(idx)],
        score: item.score ?? item.distance ?? 0,
      }));
    }
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results.map((item: Record<string, unknown>, idx: number) => ({
        clusterId: String(item.id ?? idx),
        centroidContent: String(item.content ?? item.text ?? ''),
        members: [String(item.drawer ?? idx)],
        score: Number(item.score ?? item.distance ?? 0),
      }));
    }
  } catch {
    // Not JSON, parse text format
  }

  // Parse text output
  const lines = rawOutput.trim().split('\n').filter(Boolean);
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.length > 20 && !line.startsWith('Usage:') && !line.startsWith('Options:')) {
      results.push({
        clusterId: 'result-' + idx,
        centroidContent: line,
        members: [],
        score: 0,
      });
    }
  }

  return results;
}

/**
 * Batch sync multiple learnings to mempalace
 */
export async function syncLearningsBatch(
  entries: LearningEntry[],
  wing: string = 'finger-evolution',
  room: string = 'learnings'
): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;

  for (const entry of entries) {
    const success = await syncLearningToMempalace(entry, wing, room);
    if (success) {
      synced++;
    } else {
      failed++;
    }
  }

  logger.info('InsightsEngine', 'Batch sync: ' + synced + ' synced, ' + failed + ' failed');
  return { synced, failed };
}
