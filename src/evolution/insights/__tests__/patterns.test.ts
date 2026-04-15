import { describe, it, expect } from 'vitest';
import {
  clusterFailures,
  clusterSuccesses,
  extractUserPreferences,
  extractToolUsageFromEvents,
  jaccardSimilarity,
} from '../patterns.js';
import type { LearningEntry, LedgerEvent } from '../types.js';

const mockEntries: LearningEntry[] = [
  {
    timestamp: new Date('2026-04-01T10:00:00Z'),
    successes: ['Used exec_command parallel query faster'],
    failures: ['EPIPE error kernel stdin closed'],
    tags: ['tool-optimization', 'error-pattern'],
    toolUsage: [],
    sessionId: 'session-1',
  },
  {
    timestamp: new Date('2026-04-02T10:00:00Z'),
    successes: ['Used exec_command parallel query faster'],
    failures: ['EPIPE error kernel stdin closed'],
    tags: ['tool-optimization', 'error-pattern'],
    toolUsage: [],
    sessionId: 'session-2',
  },
  {
    timestamp: new Date('2026-04-03T10:00:00Z'),
    successes: ['Used exec_command parallel query faster'],
    failures: ['EPIPE error stdin pipe broken'],
    tags: ['tool-optimization', 'error-pattern'],
    toolUsage: [],
    sessionId: 'session-3',
  },
  {
    timestamp: new Date('2026-04-04T10:00:00Z'),
    successes: ['Used patch directly'],
    failures: ['Tool exec_command missing'],
    tags: ['patch', 'tool-availability'],
    toolUsage: [],
    sessionId: 'session-4',
  },
];

describe('jaccardSimilarity', () => {
  it('computes similarity correctly', () => {
    const a = 'EPIPE error kernel stdin closed';
    const b = 'EPIPE error kernel stdin closed';
    expect(jaccardSimilarity(a, b)).toBe(1.0);
  });

  it('returns 0 for no common tokens', () => {
    const a = 'apple banana cherry';
    const b = 'dog elephant fox';
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 0.5 for half overlap', () => {
    const a = 'apple banana';
    const b = 'apple cherry';
    // intersection = apple (1), union = apple, banana, cherry (3)
    // jaccard = 1/3 ≈ 0.33
    expect(jaccardSimilarity(a, b)).toBeCloseTo(1/3, 2);
  });
});

describe('clusterFailures', () => {
  it('clusters identical failures', () => {
    const entries: LearningEntry[] = [
      {
        timestamp: new Date(),
        successes: [],
        failures: ['timeout error'],
        tags: [],
        toolUsage: [],
        sessionId: 's1',
      },
      {
        timestamp: new Date(),
        successes: [],
        failures: ['timeout error'],
        tags: [],
        toolUsage: [],
        sessionId: 's2',
      },
      {
        timestamp: new Date(),
        successes: [],
        failures: ['timeout error'],
        tags: [],
        toolUsage: [],
        sessionId: 's3',
      },
    ];

    const result = clusterFailures(entries, {
      similarityThreshold: 0.9,
      minPatternCount: 3,
    });

    expect(result.length).toBe(1);
    expect(result[0].count).toBe(3);
    expect(result[0].recommendation).toContain('timeout');
  });

  it('returns empty when minPatternCount not met', () => {
    const result = clusterFailures(mockEntries, {
      similarityThreshold: 0.99,
      minPatternCount: 5,
    });

    expect(result.length).toBe(0);
  });

  it('sorts by count descending', () => {
    const entries: LearningEntry[] = [
      {
        timestamp: new Date(),
        successes: [],
        failures: ['timeout error', 'timeout error', 'timeout error'],
        tags: [],
        toolUsage: [],
        sessionId: 's1',
      },
      {
        timestamp: new Date(),
        successes: [],
        failures: ['patch fail', 'patch fail'],
        tags: [],
        toolUsage: [],
        sessionId: 's2',
      },
    ];

    const result = clusterFailures(entries, {
      similarityThreshold: 0.9,
      minPatternCount: 2,
    });

    expect(result[0].count).toBe(3);
    expect(result[1].count).toBe(2);
  });
});

describe('clusterSuccesses', () => {
  it('clusters identical successes', () => {
    const entries: LearningEntry[] = [
      {
        timestamp: new Date(),
        successes: ['exec_command parallel'],
        failures: [],
        tags: [],
        toolUsage: [],
        sessionId: 's1',
      },
      {
        timestamp: new Date(),
        successes: ['exec_command parallel'],
        failures: [],
        tags: [],
        toolUsage: [],
        sessionId: 's2',
      },
      {
        timestamp: new Date(),
        successes: ['exec_command parallel'],
        failures: [],
        tags: [],
        toolUsage: [],
        sessionId: 's3',
      },
    ];

    const result = clusterSuccesses(entries, {
      similarityThreshold: 0.9,
      minPatternCount: 3,
    });

    expect(result.length).toBe(1);
    expect(result[0].count).toBe(3);
    expect(result[0].reusablePattern).toContain('exec_command');
  });

  it('returns empty when no patterns meet threshold', () => {
    const result = clusterSuccesses(mockEntries, {
      similarityThreshold: 0.99,
      minPatternCount: 10,
    });

    expect(result.length).toBe(0);
  });
});

describe('extractUserPreferences', () => {
  it('extracts tag frequencies', () => {
    const result = extractUserPreferences(mockEntries);

    expect(result.some((p) => p.pattern === 'tool-optimization')).toBe(true);
    expect(result.some((p) => p.pattern === 'error-pattern')).toBe(true);
  });

  it('filters low-frequency tags', () => {
    const result = extractUserPreferences(mockEntries);

    // 'patch' only appears once, filtered out
    expect(result.every((p) => p.frequency >= 2)).toBe(true);
  });

  it('computes confidence correctly', () => {
    const result = extractUserPreferences(mockEntries);

    const toolOpt = result.find((p) => p.pattern === 'tool-optimization');
    // confidence = frequency / total entries (3 of 4 entries have tool-optimization)
    expect(toolOpt?.confidence).toBe(3 / 4);
  });
});

describe('extractToolUsageFromEvents', () => {
  it('counts tool calls from ledger events', () => {
    const events: LedgerEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'exec_command', status: 'success' } },
      { id: 'e2', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'exec_command', status: 'success' } },
      { id: 'e3', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'exec_command', status: 'failure' } },
      { id: 'e4', timestamp: new Date().toISOString(), type: 'tool_call', sessionId: 's1', agentId: 'a1', data: { tool: 'patch', status: 'success' } },
    ];

    const result = extractToolUsageFromEvents(events);

    expect(result.get('exec_command')?.total).toBe(3);
    expect(result.get('exec_command')?.success).toBe(2);
    expect(result.get('exec_command')?.fail).toBe(1);
    expect(result.get('patch')?.total).toBe(1);
  });

  it('ignores non-tool events', () => {
    const events: LedgerEvent[] = [
      { id: 'e1', timestamp: new Date().toISOString(), type: 'user_input', sessionId: 's1', agentId: 'a1', data: {} },
      { id: 'e2', timestamp: new Date().toISOString(), type: 'agent_response', sessionId: 's1', agentId: 'a1', data: {} },
    ];

    const result = extractToolUsageFromEvents(events);
    expect(result.size).toBe(0);
  });
});
