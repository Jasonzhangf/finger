import fs from 'fs';
import path from 'path';

export interface FileMutexOptions {
  timeoutMs?: number;
  retryDelayMs?: number;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

export function withFileMutexSync<T>(
  lockFilePath: string,
  fn: () => T,
  options: FileMutexOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const startedAt = Date.now();

  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });

  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFilePath, 'wx');
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e?.code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`acquire file mutex timeout: ${lockFilePath}`);
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close failures
    }
    try {
      fs.unlinkSync(lockFilePath);
    } catch {
      // ignore unlink failures
    }
  }
}
