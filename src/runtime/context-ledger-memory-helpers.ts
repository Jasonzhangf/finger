import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  ContextLedgerMemoryInput,
  ContextLedgerMemoryRuntimeContext,
} from './context-ledger-memory-types.js';

export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 500;
export const DEFAULT_FOCUS_MAX_CHARS = 20_000;

export function parseInput(rawInput: unknown): ContextLedgerMemoryInput {
  if (!isRecord(rawInput)) return { action: 'query' };
  return {
    action: rawInput.action === 'insert' ? 'insert' : 'query',
    session_id: valueAsString(rawInput.session_id),
    agent_id: valueAsString(rawInput.agent_id),
    mode: valueAsString(rawInput.mode),
    since_ms: normalizePositiveInt(rawInput.since_ms),
    until_ms: normalizePositiveInt(rawInput.until_ms),
    limit: normalizePositiveInt(rawInput.limit),
    contains: valueAsString(rawInput.contains),
    fuzzy: rawInput.fuzzy === true,
    event_types: normalizeStringArray(rawInput.event_types),
    detail: rawInput.detail === true,
    text: valueAsString(rawInput.text),
    append: rawInput.append === true,
    focus_max_chars: normalizePositiveInt(rawInput.focus_max_chars),
    _runtime_context: isRecord(rawInput._runtime_context)
      ? parseRuntimeContext(rawInput._runtime_context)
      : undefined,
  };
}

export function parseRuntimeContext(rawInput: unknown): ContextLedgerMemoryRuntimeContext {
  if (!isRecord(rawInput)) return {};
  return {
    root_dir: valueAsString(rawInput.root_dir),
    session_id: valueAsString(rawInput.session_id),
    agent_id: valueAsString(rawInput.agent_id),
    mode: valueAsString(rawInput.mode),
    can_read_all: rawInput.can_read_all === true,
    readable_agents: normalizeStringArray(rawInput.readable_agents),
    focus_max_chars: normalizePositiveInt(rawInput.focus_max_chars),
  };
}

export function resolveLedgerPath(rootDir: string, sessionId: string, agentId: string, mode: string): string {
  return join(resolveBaseDir(rootDir, sessionId, agentId, mode), 'context-ledger.jsonl');
}

export function resolveCompactMemoryPath(rootDir: string, sessionId: string, agentId: string, mode: string): string {
  return join(resolveBaseDir(rootDir, sessionId, agentId, mode), 'compact-memory.jsonl');
}

export function resolveCompactMemoryIndexPath(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
): string {
  return join(resolveBaseDir(rootDir, sessionId, agentId, mode), 'compact-memory-index.json');
}

export function resolveBaseDir(rootDir: string, sessionId: string, agentId: string, mode: string): string {
  return join(rootDir, sanitizeComponent(sessionId), sanitizeComponent(agentId), sanitizeComponent(mode));
}

export function normalizeRootDir(rootDir?: string): string {
  const normalized = normalizeText(rootDir);
  if (normalized) return normalized;
  return join(homedir(), '.finger', 'sessions');
}

export async function readJsonLines<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function appendLedgerEvent(
  ledgerPath: string,
  event: {
    session_id: string;
    agent_id: string;
    mode: string;
    event_type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const now = Date.now();
  const entry = {
    id: `led-${now}-${Math.floor(Math.random() * 1_000_000)}`,
    timestamp_ms: now,
    timestamp_iso: new Date(now).toISOString(),
    session_id: event.session_id,
    agent_id: event.agent_id,
    mode: event.mode,
    event_type: event.event_type,
    payload: event.payload,
  };
  await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

export async function safeReadText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function containsPromptLikeBlock(text: string): boolean {
  const lowered = text.toLowerCase();
  return lowered.includes('<developer_instructions>')
    || lowered.includes('<user_instructions>')
    || lowered.includes('<environment_context>')
    || lowered.includes('<turn_context>')
    || lowered.includes('<context_ledger_focus>')
    || lowered.includes('<system_message>');
}

export function paginate<T>(items: T[], requestedLimit: number): { items: T[]; total: number; truncated: boolean } {
  const limit = Math.min(Math.max(1, requestedLimit), MAX_QUERY_LIMIT);
  if (items.length <= limit) return { items, total: items.length, truncated: false };
  return {
    items: items.slice(items.length - limit),
    total: items.length,
    truncated: true,
  };
}

export function buildPreview(raw: string, maxChars: number): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function fuzzyScore(text: string, query: string): number {
  const textBigrams = toBigrams(text);
  const queryBigrams = toBigrams(query);
  if (textBigrams.size === 0 || queryBigrams.size === 0) return 0;

  let intersection = 0;
  for (const item of queryBigrams) {
    if (textBigrams.has(item)) intersection += 1;
  }
  return intersection / queryBigrams.size;
}

export function keepTailChars(input: string, maxChars: number): { text: string; chars: { count: number } } {
  const chars = Array.from(input);
  if (chars.length <= maxChars) {
    return { text: input, chars: { count: chars.length } };
  }
  const tail = chars.slice(chars.length - maxChars).join('');
  return { text: tail, chars: { count: maxChars } };
}

export function pickString(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return undefined;
}

export function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizePositiveInt(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

export function toTimestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function valueAsString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toBigrams(input: string): Set<string> {
  const normalized = input.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5\s]/g, '').trim();
  const chars = Array.from(normalized);
  const out = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    const token = `${chars[index]}${chars[index + 1]}`.trim();
    if (token.length > 0) out.add(token);
  }
  return out;
}

function sanitizeComponent(raw: string): string {
  return raw.trim().replaceAll('\\', '_').replaceAll('/', '_').replaceAll(':', '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
