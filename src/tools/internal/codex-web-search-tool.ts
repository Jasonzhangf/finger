import { InternalTool } from './types.js';
import { performWebSearch, WebSearchResponse } from '../../server/tools/web-search.js';

interface WebSearchInput {
  query: string;
  max_results: number;
  timeout_ms: number;
  providers?: string[];
}

export interface WebSearchToolOutput extends WebSearchResponse {
  ok: boolean;
  query: string;
  content: string;
}

export type WebSearchPerformer = (
  query: string,
  options?: {
    maxResults?: number;
    timeoutMs?: number;
    providers?: string[];
  },
) => Promise<WebSearchResponse>;

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

export function createWebSearchTool(search: WebSearchPerformer = performWebSearch): InternalTool<unknown, WebSearchToolOutput> {
  return {
    name: 'web_search',
    description: 'Search the web and return summarized results from configured providers.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        q: { type: 'string' },
        max_results: { type: 'number' },
        timeout_ms: { type: 'number' },
        providers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: unknown): Promise<WebSearchToolOutput> => {
      const input = parseWebSearchInput(rawInput);
      const response = await search(input.query, {
        maxResults: input.max_results,
        timeoutMs: input.timeout_ms,
        providers: input.providers,
      });

      return {
        ...response,
        ok: response.success,
        query: input.query,
        content: response.success ? 'web search completed' : (response.error ?? 'web search failed'),
      };
    },
  };
}

export const webSearchTool = createWebSearchTool();

function parseWebSearchInput(rawInput: unknown): WebSearchInput {
  if (!isRecord(rawInput)) {
    throw new Error('web_search input must be an object');
  }

  const query = resolveQuery(rawInput);
  if (!query) {
    throw new Error('web_search requires query (or q)');
  }

  const maxResults = normalizePositiveInteger(rawInput.max_results, DEFAULT_MAX_RESULTS);
  const timeoutMs = normalizePositiveInteger(rawInput.timeout_ms, DEFAULT_TIMEOUT_MS);

  const providers = Array.isArray(rawInput.providers)
    ? rawInput.providers.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;

  return {
    query,
    max_results: maxResults,
    timeout_ms: timeoutMs,
    providers,
  };
}

function resolveQuery(input: Record<string, unknown>): string | null {
  const raw = typeof input.query === 'string'
    ? input.query
    : (typeof input.q === 'string' ? input.q : '');
  const normalized = raw.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
