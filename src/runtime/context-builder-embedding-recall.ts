import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import type { TaskBlock } from './context-builder-types.js';
import { getEmbeddingAdapter } from '../tools/internal/memory/embedding-adapter.js';
import { resolveBaseDir } from './context-ledger-memory-helpers.js';

const TASK_EMBEDDING_INDEX_FILE = 'task-embedding-index.json';
const TASK_EMBEDDING_INDEX_VERSION = 1;
const DEFAULT_EMBEDDING_TOP_K = 12;

interface TaskEmbeddingIndexEntry {
  taskId: string;
  signature: string;
  text: string;
  embedding: number[];
  updatedAt: string;
}

interface TaskEmbeddingIndexFile {
  version: number;
  generatedAt: string;
  entries: TaskEmbeddingIndexEntry[];
}

export interface EmbeddingRecallResult {
  executed: boolean;
  rankedTaskIds: string[];
  indexPath?: string;
  candidateCount: number;
  reason?: string;
  error?: string;
}

export async function runTaskEmbeddingRecall(input: {
  rootDir: string;
  sessionId: string;
  agentId: string;
  mode: string;
  blocks: TaskBlock[];
  currentPrompt?: string;
  topK?: number;
}): Promise<EmbeddingRecallResult> {
  const prompt = (input.currentPrompt ?? '').trim();
  if (prompt.length === 0 || input.blocks.length <= 1) {
    return {
      executed: false,
      rankedTaskIds: input.blocks.map((block) => block.id),
      candidateCount: 0,
      reason: prompt.length === 0 ? 'missing_current_prompt' : 'insufficient_blocks',
    };
  }

  const indexPath = resolveTaskEmbeddingIndexPath(
    input.rootDir,
    input.sessionId,
    input.agentId,
    input.mode,
  );

  try {
    const prepared = input.blocks.map((block) => {
      const text = buildTaskEmbeddingText(block);
      return {
        block,
        text,
        signature: createStableSignature(text),
      };
    });

    const existing = await readTaskEmbeddingIndex(indexPath);
    const existingMap = new Map(existing.entries.map((entry) => [entry.taskId, entry]));
    const nextEntries: TaskEmbeddingIndexEntry[] = [];
    const missing: Array<{ taskId: string; text: string; signature: string }> = [];

    for (const item of prepared) {
      const cached = existingMap.get(item.block.id);
      if (cached && cached.signature === item.signature && Array.isArray(cached.embedding) && cached.embedding.length > 0) {
        nextEntries.push(cached);
      } else {
        missing.push({
          taskId: item.block.id,
          text: item.text,
          signature: item.signature,
        });
      }
    }

    if (missing.length > 0) {
      const embeddingAdapter = getEmbeddingAdapter();
      const embedded = await embeddingAdapter.embedBatch(missing.map((item) => item.text));
      for (let i = 0; i < missing.length; i += 1) {
        nextEntries.push({
          taskId: missing[i].taskId,
          text: missing[i].text,
          signature: missing[i].signature,
          embedding: embedded[i]?.embedding ?? [],
          updatedAt: new Date().toISOString(),
        });
      }
      await writeTaskEmbeddingIndex(indexPath, nextEntries);
    } else if (existing.entries.length !== nextEntries.length) {
      await writeTaskEmbeddingIndex(indexPath, nextEntries);
    }

    const embeddingByTaskId = new Map(nextEntries.map((entry) => [entry.taskId, entry.embedding]));
    const embeddingAdapter = getEmbeddingAdapter();
    const promptEmbedding = (await embeddingAdapter.embed(prompt)).embedding;

    const scored = prepared
      .map((item) => ({
        taskId: item.block.id,
        score: cosineSimilarity(promptEmbedding, embeddingByTaskId.get(item.block.id) ?? []),
        startTime: item.block.startTime,
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.startTime - a.startTime;
      });

    const requestedTopK = Number.isFinite(input.topK) ? Math.max(1, Math.floor(input.topK as number)) : DEFAULT_EMBEDDING_TOP_K;
    const topK = Math.min(requestedTopK, scored.length);
    const topIds = scored.slice(0, topK).map((item) => item.taskId);
    const restIds = scored.slice(topK).map((item) => item.taskId);

    return {
      executed: true,
      rankedTaskIds: [...topIds, ...restIds],
      indexPath,
      candidateCount: topK,
      reason: 'ok',
    };
  } catch (error) {
    return {
      executed: false,
      rankedTaskIds: input.blocks.map((block) => block.id),
      candidateCount: 0,
      indexPath,
      reason: 'exception',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTaskEmbeddingText(block: TaskBlock): string {
  const firstUser = block.messages.find((message) => message.role === 'user')?.content?.trim() ?? '';
  const lastAssistant = [...block.messages]
    .reverse()
    .find((message) => message.role === 'assistant')?.content?.trim() ?? '';

  return [
    block.tags && block.tags.length > 0 ? `tags: ${block.tags.join(', ')}` : '',
    block.topic ? `topic: ${block.topic}` : '',
    firstUser ? `user: ${truncate(firstUser, 800)}` : '',
    lastAssistant ? `assistant: ${truncate(lastAssistant, 1200)}` : '',
  ]
    .filter((item) => item.length > 0)
    .join('\n');
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function createStableSignature(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${Math.abs(hash >>> 0).toString(16)}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA <= 0 || magB <= 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

async function readTaskEmbeddingIndex(indexPath: string): Promise<TaskEmbeddingIndexFile> {
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(content) as TaskEmbeddingIndexFile;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return emptyTaskEmbeddingIndex();
    }
    return {
      version: parsed.version ?? TASK_EMBEDDING_INDEX_VERSION,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date(0).toISOString(),
      entries: parsed.entries.filter((entry): entry is TaskEmbeddingIndexEntry =>
        Boolean(entry)
        && typeof entry.taskId === 'string'
        && typeof entry.signature === 'string'
        && typeof entry.text === 'string'
        && Array.isArray(entry.embedding),
      ),
    };
  } catch {
    return emptyTaskEmbeddingIndex();
  }
}

async function writeTaskEmbeddingIndex(indexPath: string, entries: TaskEmbeddingIndexEntry[]): Promise<void> {
  await fs.mkdir(dirname(indexPath), { recursive: true });
  const payload: TaskEmbeddingIndexFile = {
    version: TASK_EMBEDDING_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    entries: [...entries].sort((a, b) => a.taskId.localeCompare(b.taskId)),
  };
  await fs.writeFile(indexPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function emptyTaskEmbeddingIndex(): TaskEmbeddingIndexFile {
  return {
    version: TASK_EMBEDDING_INDEX_VERSION,
    generatedAt: new Date(0).toISOString(),
    entries: [],
  };
}

export function resolveTaskEmbeddingIndexPath(
  rootDir: string,
  sessionId: string,
  agentId: string,
  mode: string,
): string {
  return join(resolveBaseDir(rootDir, sessionId, agentId, mode), TASK_EMBEDDING_INDEX_FILE);
}
