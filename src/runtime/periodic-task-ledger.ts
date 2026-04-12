import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger.js';

const log = logger.module('periodic-task-ledger');

export interface PeriodicTaskLedgerEntry {
  slot_number: number;
  timestamp_ms: number;
  timestamp_iso: string;
  task_id: string;
  event_type: 'start' | 'digest' | 'end' | 'error';
  payload: {
    task_type?: string;
    description?: string;
    duration_ms?: number;
    status?: string;
    result_summary?: string;
    error?: string;
    [key: string]: unknown;
  };
}

export interface PeriodicTaskDigest {
  task_id: string;
  task_type: string;
  started_at_ms: number;
  ended_at_ms?: number;
  status: 'running' | 'completed' | 'failed';
  digest_entries: Array<{
    slot_number: number;
    timestamp_ms: number;
    description: string;
    result?: string;
  }>;
}

export interface PeriodicTaskLedgerConfig {
  rootDir?: string;
}

function resolvePeriodicTasksDir(rootDir?: string): string {
  const base = rootDir || process.env.HOME || '.';
  return join(base, '.finger', 'runtime', 'periodic-tasks');
}

export function resolvePeriodicTaskLedgerPath(
  taskId: string,
  rootDir?: string,
): string {
  const tasksDir = resolvePeriodicTasksDir(rootDir);
  return join(tasksDir, taskId, 'ledger.jsonl');
}

export async function ensurePeriodicTaskLedgerDir(
  taskId: string,
  rootDir?: string,
): Promise<void> {
  const ledgerPath = resolvePeriodicTaskLedgerPath(taskId, rootDir);
  const dir = join(ledgerPath, '..');
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Write a digest-only entry to periodic task ledger.
 * Only records start/digest/end — NO tool calls.
 */
export async function writePeriodicTaskEntry(
  taskId: string,
  entry: Omit<PeriodicTaskLedgerEntry, 'slot_number' | 'timestamp_ms' | 'timestamp_iso' | 'task_id'>,
  rootDir?: string,
): Promise<PeriodicTaskLedgerEntry> {
  const ledgerPath = resolvePeriodicTaskLedgerPath(taskId, rootDir);
  await ensurePeriodicTaskLedgerDir(taskId, rootDir);

  const now = Date.now();
  let slotNumber: number;

  // Auto-increment slot_number
  try {
    const existing = await fs.readFile(ledgerPath, 'utf-8');
    const lineCount = existing.split('\n').filter(line => line.trim().length > 0).length;
    slotNumber = lineCount + 1;
  } catch {
    slotNumber = 1;
  }

  const fullEntry: PeriodicTaskLedgerEntry = {
    slot_number: slotNumber,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    task_id: taskId,
    event_type: entry.event_type,
    payload: entry.payload,
  };

  await fs.appendFile(ledgerPath, `${JSON.stringify(fullEntry)}\n`, 'utf-8');
  log.info('[PeriodicTaskLedger] Entry written', { taskId, slot: slotNumber, type: entry.event_type });

  return fullEntry;
}

/**
 * Convenience: write start entry
 */
export async function writePeriodicTaskStart(
  taskId: string,
  taskType: string,
  description?: string,
  rootDir?: string,
): Promise<PeriodicTaskLedgerEntry> {
  return writePeriodicTaskEntry(taskId, {
    event_type: 'start',
    payload: { task_type: taskType, description, status: 'running' },
  }, rootDir);
}

/**
 * Convenience: write digest entry (middle execution step)
 */
export async function writePeriodicTaskDigest(
  taskId: string,
  description: string,
  result?: string,
  rootDir?: string,
): Promise<PeriodicTaskLedgerEntry> {
  return writePeriodicTaskEntry(taskId, {
    event_type: 'digest',
    payload: { description, result_summary: result },
  }, rootDir);
}

/**
 * Convenience: write end entry
 */
export async function writePeriodicTaskEnd(
  taskId: string,
  status: 'completed' | 'failed',
  resultSummary?: string,
  error?: string,
  rootDir?: string,
): Promise<PeriodicTaskLedgerEntry> {
  return writePeriodicTaskEntry(taskId, {
    event_type: status === 'completed' ? 'end' : 'error',
    payload: { status, result_summary: resultSummary, error },
  }, rootDir);
}

/**
 * Read all entries for a periodic task.
 */
export async function readPeriodicTaskLedger(
  taskId: string,
  rootDir?: string,
): Promise<PeriodicTaskLedgerEntry[]> {
  const ledgerPath = resolvePeriodicTaskLedgerPath(taskId, rootDir);
  try {
    const content = await fs.readFile(ledgerPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    return lines.map(line => JSON.parse(line) as PeriodicTaskLedgerEntry);
  } catch {
    return [];
  }
}

/**
 * Get periodic task digest summary (start + all digest entries + end).
 */
export async function getPeriodicTaskDigest(
  taskId: string,
  rootDir?: string,
): Promise<PeriodicTaskDigest | null> {
  const entries = await readPeriodicTaskLedger(taskId, rootDir);
  if (entries.length === 0) return null;

  const startEntry = entries.find(e => e.event_type === 'start');
  const endEntry = [...entries].reverse().find(e => e.event_type === 'end' || e.event_type === 'error');

  const digestEntries = entries
    .filter(e => e.event_type === 'digest')
    .map(e => ({
      slot_number: e.slot_number,
      timestamp_ms: e.timestamp_ms,
      description: String(e.payload.description || ''),
      result: e.payload.result_summary ? String(e.payload.result_summary) : undefined,
    }));

  return {
    task_id: taskId,
    task_type: startEntry?.payload.task_type ? String(startEntry.payload.task_type) : 'unknown',
    started_at_ms: startEntry?.timestamp_ms || 0,
    ended_at_ms: endEntry?.timestamp_ms,
    status: endEntry?.event_type === 'error' ? 'failed' : (endEntry ? 'completed' : 'running'),
    digest_entries: digestEntries,
  };
}

/**
 * List all periodic task IDs that have ledger files.
 */
export async function listPeriodicTaskIds(rootDir?: string): Promise<string[]> {
  const tasksDir = resolvePeriodicTasksDir(rootDir);
  try {
    const entries = await fs.readdir(tasksDir, { withFileTypes: true });
    const taskIds: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const ledgerPath = join(tasksDir, entry.name, 'ledger.jsonl');
        if (existsSync(ledgerPath)) {
          taskIds.push(entry.name);
        }
      }
    }
    return taskIds;
  } catch {
    return [];
  }
}
