import { existsSync, readFileSync, statSync } from 'fs';

interface PromptCacheEntry {
  mtimeMs: number;
  content: string;
}

const promptCache = new Map<string, PromptCacheEntry>();

export interface HotPromptResolveOptions {
  inlinePrompt: string;
  candidatePaths?: string[];
  normalize?: (prompt: string) => string;
}

export interface HotPromptResolveResult {
  prompt: string;
  source: 'inline' | 'file';
  path?: string;
}

export function resolveHotPrompt(options: HotPromptResolveOptions): HotPromptResolveResult {
  const fallbackPrompt = normalizePrompt(options.inlinePrompt, options.normalize);
  const candidates = (options.candidatePaths ?? []).filter((item) => item.trim().length > 0);

  for (const candidate of candidates) {
    const loaded = loadPromptFromFile(candidate);
    if (!loaded) continue;
    return {
      prompt: normalizePrompt(loaded, options.normalize),
      source: 'file',
      path: candidate,
    };
  }

  return {
    prompt: fallbackPrompt,
    source: 'inline',
  };
}

function loadPromptFromFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const stat = statSync(filePath);
    const cached = promptCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }

    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) return undefined;

    promptCache.set(filePath, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch {
    return undefined;
  }
}

function normalizePrompt(prompt: string, normalize?: (prompt: string) => string): string {
  const base = prompt.trim();
  if (base.length === 0) return base;
  if (!normalize) return base;
  return normalize(base).trim();
}

