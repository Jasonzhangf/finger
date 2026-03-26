import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.fn(async (text: string) => {
  if (text.includes('login') || text.includes('token') || text.includes('auth')) {
    return { embedding: [1, 0], tokens: 1 };
  }
  return { embedding: [0, 1], tokens: 1 };
});

const embedBatchMock = vi.fn(async (texts: string[]) => Promise.all(texts.map((text) => embedMock(text))));

vi.mock('../../../src/tools/internal/memory/embedding-adapter.js', () => ({
  getEmbeddingAdapter: () => ({
    embed: embedMock,
    embedBatch: embedBatchMock,
  }),
}));

describe('context-builder embedding recall', () => {
  let rootDir = '';

  beforeEach(() => {
    vi.resetModules();
    embedMock.mockClear();
    embedBatchMock.mockClear();
    rootDir = join(tmpdir(), `finger-ctx-embedding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  });

  afterEach(() => {
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it('uses embedding recall to reorder historical tasks and persists index file', async () => {
    const sessionId = 'ctx-embed-1';
    const agentId = 'finger-system-agent';
    const mode = 'main';
    const dir = join(rootDir, sessionId, agentId, mode);
    mkdirSync(dir, { recursive: true });

    const now = Date.now();
    const ledgerPath = join(dir, 'context-ledger.jsonl');
    const entries = [
      {
        id: 'msg-1',
        timestamp_ms: now - 40_000,
        role: 'user',
        content: 'Investigate login token refresh failure',
      },
      {
        id: 'msg-2',
        timestamp_ms: now - 39_000,
        role: 'assistant',
        content: 'Checking auth token flow and login refresh logic.',
      },
      {
        id: 'msg-3',
        timestamp_ms: now - 30_000,
        role: 'user',
        content: 'Review Kubernetes deployment scaling',
      },
      {
        id: 'msg-4',
        timestamp_ms: now - 29_000,
        role: 'assistant',
        content: 'Inspecting deployment replicas and autoscaling.',
      },
      {
        id: 'msg-5',
        timestamp_ms: now - 1_000,
        role: 'user',
        content: 'The login token is still broken, continue debugging',
      },
      {
        id: 'msg-6',
        timestamp_ms: now - 500,
        role: 'assistant',
        content: 'Continuing the login token investigation.',
      },
    ];

    writeFileSync(
      ledgerPath,
      entries.map((entry) => JSON.stringify({
        id: entry.id,
        timestamp_ms: entry.timestamp_ms,
        timestamp_iso: new Date(entry.timestamp_ms).toISOString(),
        session_id: sessionId,
        agent_id: agentId,
        mode,
        event_type: 'session_message',
        payload: {
          role: entry.role,
          content: entry.content,
          token_count: 20,
        },
      })).join('\n') + '\n',
      'utf-8',
    );

    const { buildContext } = await import('../../../src/runtime/context-builder.js');
    const result = await buildContext(
      {
        rootDir,
        sessionId,
        agentId,
        mode,
        currentPrompt: 'Please continue debugging the login token refresh bug',
      },
      {
        targetBudget: 1_000_000,
        includeMemoryMd: false,
        buildMode: 'aggressive',
        enableModelRanking: false,
      },
    );

    expect(result.metadata.embeddingRecallExecuted).toBe(true);
    expect(result.metadata.embeddingCandidateCount).toBeGreaterThan(0);
    expect(embedBatchMock).toHaveBeenCalledTimes(1);
    expect(embedMock).toHaveBeenCalled();

    expect(result.rankedTaskBlocks[0]?.messages[0]?.content).toContain('Investigate login token refresh failure');
    expect(result.rankedTaskBlocks[1]?.messages[0]?.content).toContain('Review Kubernetes deployment scaling');

    const embeddingIndexPath = join(dir, 'task-embedding-index.json');
    expect(existsSync(embeddingIndexPath)).toBe(true);
    const embeddingIndex = JSON.parse(readFileSync(embeddingIndexPath, 'utf-8')) as { entries?: Array<{ taskId: string }> };
    expect(Array.isArray(embeddingIndex.entries)).toBe(true);
    expect(embeddingIndex.entries?.length).toBe(2);
  });
});
