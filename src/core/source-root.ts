import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';

export function resolveSourceRoot(): string {
  const override = process.env.FINGER_SOURCE_ROOT;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const up2 = dirname(dirname(currentDir));
  const base = basename(up2);
  if (base === 'dist' || base === 'src') {
    return dirname(up2);
  }
  return up2;
}

export const FINGER_SOURCE_ROOT = resolveSourceRoot();
