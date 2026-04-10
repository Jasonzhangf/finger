/**
 * Mempalace Bridge Module
 * Wrapper around /opt/homebrew/bin/mempalace CLI for cross-session memory search
 */

import { logger } from '../../../core/logger.js';
import { spawn } from 'child_process';

const MEMPALACE_CLI_PATH = '/opt/homebrew/bin/mempalace';

export interface MempalaceSearchResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  source_file?: string;
  drawer?: string;
}

export interface MempalaceSearchOptions {
  wing?: string;
  room?: string;
  limit?: number;
}

export interface MempalaceMineOptions {
  dir?: string;
}

export interface MempalaceHealthResult {
  healthy: boolean;
  daemon_running?: boolean;
  indexed_wings?: number;
  indexed_rooms?: number;
  indexed_drawers?: number;
  error?: string;
}

/**
 * Execute mempalace CLI command and return parsed output
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
 * Parse mempalace search output
 * Expected format: JSON-like structured output or plain text lines
 */
function parseSearchOutput(rawOutput: string): MempalaceSearchResult[] {
  const results: MempalaceSearchResult[] = [];
  const lines = rawOutput.trim().split('\n').filter((line) => line.trim());

  // Try JSON parsing first (if mempalace outputs JSON)
  try {
    const parsed = JSON.parse(rawOutput);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        id: item.id ?? String(item.drawer ?? ''),
        content: item.content ?? item.text ?? String(item),
        score: item.score ?? item.distance ?? 0,
        metadata: item.metadata ?? {},
        source_file: item.source_file ?? item.file,
        drawer: item.drawer,
      }));
    }
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results.map((item: Record<string, unknown>) => ({
        id: String(item.id ?? item.drawer ?? ''),
        content: String(item.content ?? item.text ?? ''),
        score: Number(item.score ?? item.distance ?? 0),
        metadata: (item.metadata as Record<string, unknown>) ?? {},
        source_file: String(item.source_file ?? item.file ?? ''),
        drawer: String(item.drawer ?? ''),
      }));
    }
  } catch {
    // Not JSON, parse text output
  }

  // Parse text output format (expected: score-based results)
  // Format varies - try common patterns
  for (const line of lines) {
    // Pattern: "drawer_name: content..." or "score: 0.85 content..."
    const scoreMatch = line.match(/^score:\s*([\d.]+)\s+(.+)$/i);
    if (scoreMatch) {
      results.push({
        id: `result-${results.length}`,
        content: scoreMatch[2],
        score: parseFloat(scoreMatch[1]),
      });
      continue;
    }

    const drawerMatch = line.match(/^([^\s:]+):\s+(.+)$/);
    if (drawerMatch) {
      results.push({
        id: drawerMatch[1],
        content: drawerMatch[2],
        score: 0,
        drawer: drawerMatch[1],
      });
      continue;
    }

    // Fallback: treat line as content
    if (line.length > 10 && !line.startsWith('Usage:') && !line.startsWith('Options:')) {
      results.push({
        id: `result-${results.length}`,
        content: line,
        score: 0,
      });
    }
  }

  return results;
}

/**
 * Search mempalace for matching content
 */
export async function searchMempalace(
  query: string,
  options: MempalaceSearchOptions = {}
): Promise<MempalaceSearchResult[]> {
  const args = ['search', query];
  if (options.wing) args.push('--wing', options.wing);
  if (options.room) args.push('--room', options.room);
  if (options.limit) args.push('-n', String(options.limit));

  logger.module('mempalace-bridge').debug('Executing mempalace search', {
    query,
    options,
    args,
  });

  try {
    const { stdout, stderr, exitCode } = await executeMempalace(args);

    if (exitCode !== 0) {
      logger.module('mempalace-bridge').warn('Mempalace search failed', {
        exitCode,
        stderr,
        query,
      });
      return [];
    }

    const results = parseSearchOutput(stdout);
    logger.module('mempalace-bridge').debug('Mempalace search completed', {
      query,
      resultCount: results.length,
    });
    return results;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.module('mempalace-bridge').error('Mempalace search error', err, { query });
    return [];
  }
}

/**
 * Mine a directory for new content to index
 */
export async function mineMempalace(options: MempalaceMineOptions = {}): Promise<{ success: boolean; indexed?: number }> {
  const args = ['mine'];
  if (options.dir) args.push(options.dir);

  logger.module('mempalace-bridge').debug('Executing mempalace mine', {
    options,
    args,
  });

  try {
    const { stdout, stderr, exitCode } = await executeMempalace(args, 120_000);

    if (exitCode !== 0) {
      logger.module('mempalace-bridge').warn('Mempalace mine failed', {
        exitCode,
        stderr,
      });
      return { success: false };
    }

    // Parse indexed count from output if available
    const indexedMatch = stdout.match(/indexed:\s*(\d+)/i) || stdout.match(/(\d+)\s+files/i);
    const indexed = indexedMatch ? parseInt(indexedMatch[1], 10) : undefined;

    logger.module('mempalace-bridge').debug('Mempalace mine completed', {
      indexed,
    });
    return { success: true, indexed };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.module('mempalace-bridge').error('Mempalace mine error', err, {});
    return { success: false };
  }
}

/**
 * Check mempalace health status
 */
export async function healthMempalace(): Promise<MempalaceHealthResult> {
  const args = ['health'];

  try {
    const { stdout, stderr, exitCode } = await executeMempalace(args);

    if (exitCode !== 0) {
      return {
        healthy: false,
        error: stderr || 'Mempalace health check failed',
      };
    }

    // Parse health output
    const daemonMatch = stdout.match(/daemon:\s*(\w+)/i);
    const wingsMatch = stdout.match(/wings:\s*(\d+)/i);
    const roomsMatch = stdout.match(/rooms:\s*(\d+)/i);
    const drawersMatch = stdout.match(/drawers:\s*(\d+)/i);

    return {
      healthy: stdout.includes('healthy') || stdout.includes('ok') || exitCode === 0,
      daemon_running: daemonMatch ? daemonMatch[1] === 'running' : undefined,
      indexed_wings: wingsMatch ? parseInt(wingsMatch[1], 10) : undefined,
      indexed_rooms: roomsMatch ? parseInt(roomsMatch[1], 10) : undefined,
      indexed_drawers: drawersMatch ? parseInt(drawersMatch[1], 10) : undefined,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get mempalace status
 */
export async function statusMempalace(): Promise<Record<string, unknown>> {
  const args = ['status'];

  try {
    const { stdout, exitCode } = await executeMempalace(args);

    if (exitCode !== 0) {
      return { error: 'Failed to get status' };
    }

    // Parse status output into structured format
    const status: Record<string, unknown> = {};
    const lines = stdout.split('\n');

    for (const line of lines) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match) {
        status[match[1]] = match[2].trim();
      }
    }

    return status;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Check if mempalace CLI is available
 */
export function isMempalaceAvailable(): boolean {
  try {
    const result = spawn(MEMPALACE_CLI_PATH, ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}