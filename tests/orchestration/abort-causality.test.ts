import { describe, it, expect, beforeEach } from 'vitest';
import { abortCausality, type AbortEvent, type SyntheticToolResult } from './abort-causality';

describe('abort-causality', () => {
  beforeEach(() => {
    abortCausality.clearChain();
  });

  it('records a single abort event and returns it in the chain', () => {
    const event: AbortEvent = {
      sessionId: 'sess-1',
      reason: 'timeout',
      timestamp: '2025-01-01T00:00:00.000Z',
      syntheticResult: {
        type: 'synthetic_error',
        error: 'Agent test-agent was aborted: timeout',
        abortReason: 'timeout',
        sessionId: 'sess-1',
        timestamp: '2025-01-01T00:00:00.000Z',
      } as SyntheticToolResult,
    };
    abortCausality.recordAbortion(event);

    const chain = abortCausality.queryAbortChain();
    expect(chain).toHaveLength(1);
    expect(chain[0].sessionId).toBe('sess-1');
    expect(chain[0].reason).toBe('timeout');
    expect(chain[0].syntheticResult.type).toBe('synthetic_error');
  });

  it('filters by sessionId', () => {
    const eventA: AbortEvent = {
      sessionId: 'sess-a',
      reason: 'SIGTERM',
      timestamp: '2025-01-01T00:00:00.000Z',
      syntheticResult: {} as SyntheticToolResult,
    };
    const eventB: AbortEvent = {
      sessionId: 'sess-b',
      reason: 'OOM',
      timestamp: '2025-01-01T00:01:00.000Z',
      syntheticResult: {} as SyntheticToolResult,
    };
    abortCausality.recordAbortion(eventA);
    abortCausality.recordAbortion(eventB);

    const filtered = abortCausality.queryAbortChain('sess-a');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].reason).toBe('SIGTERM');
  });

  it('returns all events when no sessionId filter', () => {
    for (let i = 0; i < 3; i++) {
      abortCausality.recordAbortion({
        sessionId: `sess-${i}`,
        reason: `reason-${i}`,
        timestamp: `2025-01-01T00:0${i}:00.000Z`,
        syntheticResult: {} as SyntheticToolResult,
      });
    }
    expect(abortCausality.queryAbortChain()).toHaveLength(3);
  });

  it('clearChain resets the abort chain', () => {
    abortCausality.recordAbortion({
      sessionId: 'sess-x',
      reason: 'test',
      timestamp: '2025-01-01T00:00:00.000Z',
      syntheticResult: {} as SyntheticToolResult,
    });
    abortCausality.clearChain();
    expect(abortCausality.queryAbortChain()).toHaveLength(0);
  });

  it('returns an empty array for unknown sessionId', () => {
    abortCausality.recordAbortion({
      sessionId: 'known',
      reason: 'test',
      timestamp: '2025-01-01T00:00:00.000Z',
      syntheticResult: {} as SyntheticToolResult,
    });
    expect(abortCausality.queryAbortChain('unknown')).toHaveLength(0);
  });
});
import { abortCausality, type AbortEvent, type SyntheticToolResult } from '../../src/orchestration/abort-causality';
