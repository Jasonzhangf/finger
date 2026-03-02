import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const BASE_DIR = join(os.homedir(), '.finger', 'tests', 'tmp');

export function createTempDir(prefix = 'block-test-'): string {
  mkdirSync(BASE_DIR, { recursive: true });
  return mkdtempSync(join(BASE_DIR, prefix));
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = createTempDir();
  try {
    return await fn(dir);
  } finally {
    cleanupTempDir(dir);
  }
}
