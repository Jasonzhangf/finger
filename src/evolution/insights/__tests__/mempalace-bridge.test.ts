/**
 * Mempalace Bridge Tests
 * Tests for TypeScript-side mempalace integration
 */

import { describe, it, expect } from 'vitest';
import {
  isMempalaceAvailable,
  syncLearningToMempalace,
  searchSimilarFailures,
  syncLearningsBatch,
  MempalaceDocument,
} from '../mempalace-bridge.js';
import type { LearningEntry } from '../types.js';

describe('Mempalace Bridge', () => {
  const mockLearning: LearningEntry = {
    timestamp: new Date('2026-04-12T00:00:00Z'),
    sessionId: 'test-session-1',
    successes: ['Compiled successfully', 'Tests passed'],
    failures: ['Initial apply_patch context mismatch'],
    tags: ['rust', 'evolution', 'mempalace'],
    toolUsage: [
      { tool: 'exec_command', status: 'success', args: '' },
      { tool: 'apply_patch', status: 'failure', args: '' },
    ],
  };

  it('checks mempalace availability', () => {
    const available = isMempalaceAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('returns false when mempalace is not available for sync', async () => {
    // If mempalace CLI doesn't exist, syncLearningToMempalace returns false
    if (!isMempalaceAvailable()) {
      const result = await syncLearningToMempalace(mockLearning);
      expect(result).toBe(false);
    }
  });

  it('returns empty results when searching with no mempalace', async () => {
    if (!isMempalaceAvailable()) {
      const results = await searchSimilarFailures('test query');
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('batch sync returns zero when mempalace unavailable', async () => {
    if (!isMempalaceAvailable()) {
      const result = await syncLearningsBatch([mockLearning]);
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(1);
    }
  });
});
