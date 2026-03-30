import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import type { ExecutionUpdateEvent } from './execution-update-types.js';

const log = logger.module('ExecutionUpdateEventStore');

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024; // 64MB

function getDayStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function parseDayStamp(fileName: string): Date | null {
  const match = fileName.match(/^canonical-(\d{8})\.jsonl$/);
  if (!match) return null;
  const token = match[1];
  const y = Number.parseInt(token.slice(0, 4), 10);
  const m = Number.parseInt(token.slice(4, 6), 10) - 1;
  const d = Number.parseInt(token.slice(6, 8), 10);
  const date = new Date(y, m, d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ExecutionUpdateEventStore {
  private readonly dir = path.join(FINGER_PATHS.runtime.eventsDir, 'canonical');
  private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      await mkdir(this.dir, { recursive: true });
      await this.cleanup();
      this.cleanupTimer = setInterval(() => {
        void this.cleanup().catch((error) => {
          log.warn('Canonical event cleanup failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 24 * 60 * 60 * 1000);
      this.cleanupTimer.unref?.();
      this.ready = true;
      log.info('Canonical event store initialized', { dir: this.dir });
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async append(event: ExecutionUpdateEvent): Promise<void> {
    await this.init();
    const targetFile = await this.resolveWritableFile();
    await appendFile(targetFile, JSON.stringify(event) + '\n', 'utf-8');
  }

  private async resolveWritableFile(): Promise<string> {
    const dayFile = path.join(this.dir, `canonical-${getDayStamp()}.jsonl`);
    try {
      const fileStat = await stat(dayFile);
      if (fileStat.size < this.maxFileBytes) {
        return dayFile;
      }
      const rolloverSuffix = Date.now().toString(36);
      return path.join(this.dir, `canonical-${getDayStamp()}-${rolloverSuffix}.jsonl`);
    } catch {
      return dayFile;
    }
  }

  async cleanup(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.startsWith('canonical-') && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);

    if (files.length === 0) return;

    const now = Date.now();
    const maxAgeMs = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const removable = new Set<string>();
    for (const fileName of files) {
      const parsed = parseDayStamp(fileName);
      if (!parsed) continue;
      if (now - parsed.getTime() > maxAgeMs) {
        removable.add(fileName);
      }
    }

    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    if (sorted.length - removable.size > DEFAULT_MAX_FILES) {
      const keepSet = new Set(sorted.slice(-DEFAULT_MAX_FILES));
      for (const fileName of sorted) {
        if (!keepSet.has(fileName)) removable.add(fileName);
      }
    }

    let removed = 0;
    for (const fileName of removable) {
      await rm(path.join(this.dir, fileName), { force: true });
      removed += 1;
    }
    if (removed > 0) {
      log.info('Canonical event files cleaned', {
        removed,
        kept: Math.max(0, files.length - removed),
      });
    }
  }
}
