import fs from 'fs';
import path from 'path';
import { promises as fsp } from 'fs';

function buildTempPath(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function removeIfExistsSync(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best effort cleanup for temp files.
  }
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fsp.unlink(filePath);
  } catch {
    // Best effort cleanup for temp files.
  }
}

export function writeFileAtomicSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  let tmpPath = buildTempPath(filePath);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    removeIfExistsSync(tmpPath);
    if (!isEnoent(error)) throw error;
    // Directory may have been cleaned/rebound between write and rename.
    fs.mkdirSync(dir, { recursive: true });
    tmpPath = buildTempPath(filePath);
    fs.writeFileSync(tmpPath, content, 'utf-8');
    try {
      fs.renameSync(tmpPath, filePath);
    } finally {
      removeIfExistsSync(tmpPath);
    }
  }
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  let tmpPath = buildTempPath(filePath);
  await fsp.writeFile(tmpPath, content, 'utf-8');
  try {
    await fsp.rename(tmpPath, filePath);
  } catch (error) {
    await removeIfExists(tmpPath);
    if (!isEnoent(error)) throw error;
    // Directory may have been cleaned/rebound between write and rename.
    await fsp.mkdir(dir, { recursive: true });
    tmpPath = buildTempPath(filePath);
    await fsp.writeFile(tmpPath, content, 'utf-8');
    try {
      await fsp.rename(tmpPath, filePath);
    } finally {
      await removeIfExists(tmpPath);
    }
  }
}
