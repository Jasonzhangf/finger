import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from './finger-paths.js';
import { logger } from './logger.js';

const log = logger.module('ProjectDreamLock');

export const DEFAULT_PROJECT_DREAM_LOCK_TTL_MS = 8 * 60 * 60 * 1000;
const LOCK_FILENAME = '.dream.lock';

interface ProjectDreamLockRecord {
  projectSlug: string;
  runId: string;
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AcquireProjectDreamLockInput {
  projectSlug: string;
  runId: string;
  lockTtlMs?: number;
  owner?: string;
  memoryProjectsRoot?: string;
}

export interface AcquireProjectDreamLockResult {
  acquired: boolean;
  lockPath: string;
  reason: 'acquired' | 'reentrant' | 'busy' | 'invalid';
  staleReplaced?: boolean;
  existingRunId?: string;
}

export interface ReleaseProjectDreamLockInput {
  projectSlug: string;
  runId?: string;
  memoryProjectsRoot?: string;
}

export interface ReleaseProjectDreamLockResult {
  released: boolean;
  lockPath: string;
  reason: 'released' | 'missing' | 'run_id_mismatch' | 'invalid';
  existingRunId?: string;
}

function normalizeSlug(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

function resolveProjectMemoryRoot(override?: string): string {
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(FINGER_PATHS.home, 'memory', 'projects');
}

function resolveProjectLockPath(projectSlug: string, memoryProjectsRoot?: string): string {
  const root = resolveProjectMemoryRoot(memoryProjectsRoot);
  return path.join(root, projectSlug, LOCK_FILENAME);
}

function resolveLockTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_PROJECT_DREAM_LOCK_TTL_MS;
  return Math.max(60_000, Math.floor(value as number));
}

async function readLockRecord(lockPath: string): Promise<ProjectDreamLockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ProjectDreamLockRecord>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.projectSlug !== 'string' || parsed.projectSlug.trim().length === 0) return null;
    if (typeof parsed.runId !== 'string' || parsed.runId.trim().length === 0) return null;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.updatedAt !== 'string') return null;
    return {
      projectSlug: parsed.projectSlug.trim(),
      runId: parsed.runId.trim(),
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.owner === 'string' && parsed.owner.trim().length > 0 ? { owner: parsed.owner.trim() } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return null;
    log.warn('[project-dream-lock] Failed to read lock record', {
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function isLockStale(record: ProjectDreamLockRecord | null, lockTtlMs: number): boolean {
  if (!record) return true;
  const updatedAtMs = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return true;
  return Date.now() - updatedAtMs > lockTtlMs;
}

async function unlinkIfExists(lockPath: string): Promise<void> {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return;
    throw error;
  }
}

export async function acquireProjectDreamLock(input: AcquireProjectDreamLockInput): Promise<AcquireProjectDreamLockResult> {
  const projectSlug = normalizeSlug(input.projectSlug);
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  const lockPath = resolveProjectLockPath(projectSlug, input.memoryProjectsRoot);
  if (!projectSlug || !runId) {
    return { acquired: false, lockPath, reason: 'invalid' };
  }

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lockTtlMs = resolveLockTtlMs(input.lockTtlMs);
  const nowIso = new Date().toISOString();
  let staleReplaced = false;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readLockRecord(lockPath);
    if (existing && !isLockStale(existing, lockTtlMs)) {
      if (existing.runId === runId) {
        return { acquired: false, lockPath, reason: 'reentrant', existingRunId: existing.runId };
      }
      return { acquired: false, lockPath, reason: 'busy', existingRunId: existing.runId };
    }
    if (existing && isLockStale(existing, lockTtlMs)) {
      staleReplaced = true;
      await unlinkIfExists(lockPath);
    }

    const handle = await fs.open(lockPath, 'wx').catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EEXIST') return null;
      throw error;
    });
    if (!handle) continue;

    try {
      const payload: ProjectDreamLockRecord = {
        projectSlug,
        runId,
        createdAt: nowIso,
        updatedAt: nowIso,
        ...(typeof input.owner === 'string' && input.owner.trim().length > 0 ? { owner: input.owner.trim() } : {}),
      };
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
      return { acquired: true, lockPath, reason: 'acquired', ...(staleReplaced ? { staleReplaced: true } : {}) };
    } finally {
      await handle.close();
    }
  }

  const existing = await readLockRecord(lockPath);
  if (existing?.runId === runId) {
    return { acquired: false, lockPath, reason: 'reentrant', existingRunId: existing.runId };
  }
  return {
    acquired: false,
    lockPath,
    reason: 'busy',
    ...(existing?.runId ? { existingRunId: existing.runId } : {}),
  };
}

export async function releaseProjectDreamLock(input: ReleaseProjectDreamLockInput): Promise<ReleaseProjectDreamLockResult> {
  const projectSlug = normalizeSlug(input.projectSlug);
  const runId = typeof input.runId === 'string' ? input.runId.trim() : '';
  const lockPath = resolveProjectLockPath(projectSlug, input.memoryProjectsRoot);
  if (!projectSlug) return { released: false, lockPath, reason: 'invalid' };

  const existing = await readLockRecord(lockPath);
  if (!existing) {
    return { released: false, lockPath, reason: 'missing' };
  }
  if (runId && existing.runId !== runId) {
    return {
      released: false,
      lockPath,
      reason: 'run_id_mismatch',
      existingRunId: existing.runId,
    };
  }
  await unlinkIfExists(lockPath);
  return {
    released: true,
    lockPath,
    reason: 'released',
    existingRunId: existing.runId,
  };
}
