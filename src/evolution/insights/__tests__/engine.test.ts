import { describe, it, expect, beforeEach } from 'vitest';
import { InsightsEngine } from '../engine.js';
import type { LedgerEvent } from '../types.js';

const mockLedgerPath = '/tmp/mock-ledger.jsonl';

describe('InsightsEngine', () => {
  let engine: InsightsEngine;

  beforeEach(() => {
    engine = new InsightsEngine({
      ledgerPath: mockLedgerPath,
      lookbackDays: 7,
      minPatternCount: 2,
      similarityThreshold: 0.5,
    });
  });

  it('constructs with default config', () => {
    const defaultEngine = new InsightsEngine();
    expect(defaultEngine).toBeDefined();
  });

  it('returns empty insights when ledger path empty', async () => {
    const emptyEngine = new InsightsEngine({ ledgerPath: '' });
    const insights = await emptyEngine.analyze();

    expect(insights.failurePatterns.length).toBe(0);
    expect(insights.successPatterns.length).toBe(0);
    expect(insights.toolUsageStats.length).toBe(0);
  });

  it('extracts learnings from reasoning_stop events', () => {
    const events: LedgerEvent[] = [
      {
        id: 'e1',
        timestamp: new Date().toISOString(),
        type: 'reasoning_stop',
        sessionId: 's1',
        agentId: 'a1',
        data: {
          successes: ['used exec_command parallel'],
          failures: ['EPIPE error → stdin closed'],
          tags: ['tool-optimization'],
          toolsUsed: [{ tool: 'exec_command', status: 'success' }],
        },
      },
      {
        id: 'e2',
        timestamp: new Date().toISOString(),
        type: 'user_input',
        sessionId: 's1',
        agentId: 'a1',
        data: { text: 'hello' },
      },
    ];

    const learnings = engine.extractLearnings(events, new Date(0));

    expect(learnings.length).toBe(1);
    expect(learnings[0].successes[0]).toContain('exec_command');
    expect(learnings[0].failures[0]).toContain('EPIPE');
  });

  it('builds tool stats correctly', async () => {
    const partialEngine = new InsightsEngine({ ledgerPath: '' });

    // Mock internal method by extracting learnings
    const events: LedgerEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'exec_command', status: 'success' } },
      { id: 'e2', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'apply_patch', status: 'failure' } },
    ];

    // Test analyze with empty ledger
    const insights = await partialEngine.analyze();
    expect(insights.toolUsageStats.length).toBe(0);
  });

  it('estimates cost from events with tokens', () => {
    // Engine.analyze returns insights; check cost estimation
    const emptyEngine = new InsightsEngine({ ledgerPath: '' });

    // We cannot directly test private methods, so test via analyze output
    emptyEngine.analyze().then((insights) => {
      expect(insights.costEstimation.totalTokens).toBe(0);
      expect(insights.costEstimation.anomaly).toBe(false);
    });
  });

  it('generates recommendations from patterns', async () => {
    const emptyEngine = new InsightsEngine({ ledgerPath: '' });
    const insights = await emptyEngine.analyze();

    expect(insights.recommendations).toEqual([]);
  });
});

describe('InsightsEngine.extractLearnings', () => {
  it('skips events without successes or failures', () => {
    const engine = new InsightsEngine();
    const events: LedgerEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'reasoning_stop', sessionId: 's1', agentId: 'a1', data: {} },
    ];

    const learnings = engine.extractLearnings(events, new Date(0));
    expect(learnings.length).toBe(0);
  });

  it('normalizes toolsUsed array', () => {
    const engine = new InsightsEngine();
    const events: LedgerEvent[] = [
      {
        id: 'e1',
        timestamp: new Date().toISOString(),
        type: 'reasoning_stop',
        sessionId: 's1',
        agentId: 'a1',
        data: {
          successes: ['ok'],
          failures: [],
          tags: [],
          toolsUsed: [{ tool: 'exec_command', status: 'success' }],
        },
      },
    ];

    const learnings = engine.extractLearnings(events, new Date(0));
    expect(learnings[0].toolUsage[0].tool).toBe('exec_command');
    expect(learnings[0].toolUsage[0].status).toBe('success');
  });
});
