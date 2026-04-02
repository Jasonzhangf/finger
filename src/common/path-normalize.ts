import fs from 'fs';
import path from 'path';

function expandHome(input: string): string {
  if (!input.startsWith('~/')) return input;
  const home = process.env.HOME || '';
  if (!home) return input;
  return path.join(home, input.slice(2));
}

/**
 * Normalize project path to a canonical comparable value.
 * - expand "~/".
 * - resolve relative segments.
 * - collapse symlink aliases via realpath when possible.
 */
export function normalizeProjectPathCanonical(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) return '';
  const resolved = path.resolve(expandHome(trimmed));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

