import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../../src/utils/token-counter.js';
import { buildSnapshotContextBuild } from '../../../src/server/routes/ledger-routes-context-build.js';

describe('buildSnapshotContextBuild', () => {
  it('fails fast when session snapshot is missing', () => {
    const result = buildSnapshotContextBuild(undefined, { targetBudget: 20000 });

    expect(result).toEqual({
      ok: false,
      error: 'Session snapshot not found',
      messages: [],
    });
  });

  it('summarizes working-set and historical-memory messages from Session.messages only', () => {
    const digestContent = '[context_digest] topic-a\nold summary';
    const rawContent = 'latest raw assistant reply';

    const result = buildSnapshotContextBuild(
      [
        {
          id: 'digest-1',
          role: 'assistant',
          content: digestContent,
          timestamp: '2026-04-15T10:00:00.000Z',
          metadata: {
            compactDigest: true,
            contextZone: 'historical_memory',
          },
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: rawContent,
          timestamp: '2026-04-15T10:01:00.000Z',
          metadata: {
            contextZone: 'working_set',
          },
        },
      ],
      {
        targetBudget: 20000,
        buildTimestamp: '2026-04-15T10:05:00.000Z',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.messages).toEqual([
      {
        id: 'digest-1',
        role: 'assistant',
        content: digestContent,
        timestampIso: '2026-04-15T10:00:00.000Z',
        tokenCount: estimateTokens(digestContent),
        contextZone: 'historical_memory',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: rawContent,
        timestampIso: '2026-04-15T10:01:00.000Z',
        tokenCount: estimateTokens(rawContent),
        contextZone: 'working_set',
      },
    ]);
    expect(result.metadata).toEqual({
      rawTaskBlockCount: 2,
      timeWindowFilteredCount: 2,
      budgetTruncatedCount: 0,
      targetBudget: 20000,
      actualTokens: estimateTokens(digestContent) + estimateTokens(rawContent),
      workingSetMessageCount: 1,
      historicalMessageCount: 1,
      workingSetTokens: estimateTokens(rawContent),
      historicalTokens: estimateTokens(digestContent),
    });
    expect(result.totalTokens).toBe(estimateTokens(digestContent) + estimateTokens(rawContent));
    expect(result.buildTimestamp).toBe('2026-04-15T10:05:00.000Z');
  });
});
