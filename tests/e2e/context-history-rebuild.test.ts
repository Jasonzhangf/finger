import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rebuildByOverflow, rebuildByTopic, makeRebuildDecision, DEFAULT_CONFIG } from '../../src/runtime/context-history/index.js';
import type { SessionMessage } from '../../src/orchestration/session-types.js';

function writeLedger(rootDir: string): string {
  const dir = join(rootDir, 'session-1', 'finger-system-agent', 'main');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const entries = [
    {
      event_type: 'context_compact',
      timestamp_ms: now - 60000,
      timestamp_iso: new Date(now - 60000).toISOString(),
      payload: {
        replacement_history: [
          {
            request: '处理 context rebuild',
            summary: '整理 overflow/topic 唯一实现',
            key_tools: ['patch'],
            key_reads: ['src/runtime/context-history/rebuild.ts'],
            key_writes: ['src/runtime/context-history/rebuild.ts'],
            tags: ['context', 'rebuild'],
            topic: 'context rebuild',
            tokenCount: 160,
            key_entities: ['context', 'rebuild'],
          },
        ],
      },
    },
  ];
  const ledgerPath = join(dir, 'context-ledger.jsonl');
  writeFileSync(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
  return ledgerPath;
}

function createLargeConversation(): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let index = 0; index < 40; index += 1) {
    messages.push({
      id: 'm-' + String(index + 1),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: '长历史消息 '.repeat(80) + String(index + 1),
      timestamp: new Date(Date.now() - (40 - index) * 1000).toISOString(),
    });
  }
  return messages;
}

describe('context-history rebuild e2e', () => {
  let rootDir = '';
  let ledgerPath = '';

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'finger-context-history-e2e-'));
    ledgerPath = writeLedger(rootDir);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('overflow rebuild outputs historical digests plus working set raw messages', async () => {
    const result = await rebuildByOverflow('session-1', ledgerPath, createLargeConversation(), DEFAULT_CONFIG.budgetTokens);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('overflow');
    expect(result.messages.some((message) => message.metadata?.compactDigest === true)).toBe(true);
    expect(result.messages.some((message) => message.metadata?.contextZone === 'working_set')).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(DEFAULT_CONFIG.budgetTokens);
  });

  it('topic rebuild recalls matched digest history and keeps time order', async () => {
    const result = await rebuildByTopic('session-1', ledgerPath, 'context rebuild', {
      keywords: ['context', 'rebuild'],
      topK: 20,
      relevanceThreshold: 0.1,
      budgetTokens: DEFAULT_CONFIG.budgetTokens,
      currentMessages: [],
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('topic');
    expect(result.digestCount).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.metadata?.compactDigest === true)).toBe(true);
  });

  it('decision only auto-triggers on overflow or explicit topic signal', () => {
    const noOverflow = makeRebuildDecision('session-1', [], '继续');
    expect(noOverflow.shouldRebuild).toBe(false);

    const overflow = makeRebuildDecision('session-1', createLargeConversation(), '继续', undefined, undefined, 2000);
    expect(overflow.shouldRebuild).toBe(true);
    expect(overflow.mode).toBe('overflow');

    const topicShift = makeRebuildDecision('session-1', [], '处理 context rebuild', 'context rebuild', 0.9);
    expect(topicShift.shouldRebuild).toBe(true);
    expect(topicShift.mode).toBe('topic');
  });
});
