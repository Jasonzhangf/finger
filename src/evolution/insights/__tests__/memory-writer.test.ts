import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  computeDedupKey,
  extractExistingKeys,
  extractLearningsSection,
  formatLearningEntry,
  appendLearningsToMemory,
} from '../memory-writer.js';
import type { LearningEntry } from '../types.js';

const tmpDir = '/tmp/finger-memory-writer-test';
const memoryPath = join(tmpDir, 'MEMORY.md');

describe('memory-writer', () => {
  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    // Start with empty file
    await writeFile(memoryPath, '# Project Memory\n', 'utf-8');
  });

  afterEach(async () => {
    try {
      await rm(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
  });

  describe('computeDedupKey', () => {
    it('computes key from tags + failures + goal', () => {
      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['used exec_command'],
        failures: ['EPIPE error'],
        tags: ['tool-optimization', 'debug'],
        toolUsage: [],
      };
      const key = computeDedupKey(entry);
      expect(key).toContain('debug,tool-optimization');
      expect(key).toContain('EPIPE error');
    });

    it('sorts tags and failures for stable comparison', () => {
      const entry1: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['used exec_command'],
        failures: ['B', 'A'],
        tags: ['b', 'a'],
        toolUsage: [],
      };
      const entry2: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's2',
        successes: ['used exec_command'],
        failures: ['A', 'B'],
        tags: ['a', 'b'],
        toolUsage: [],
      };
      expect(computeDedupKey(entry1)).toBe(computeDedupKey(entry2));
    });
  });

  describe('extractLearningsSection', () => {
    it('returns empty if section not found', () => {
      const content = '# Memory\n\n## Facts\nSome facts\n';
      expect(extractLearningsSection(content)).toBe('');
    });

    it('extracts content between ## Learnings and next ## header', () => {
      const content = '# Memory\n\n## Learnings\nEntry 1\n\n## Facts\nOther\n';
      const section = extractLearningsSection(content);
      expect(section).toContain('Entry 1');
      expect(section).not.toContain('Other');
    });

    it('extracts until end if no next header', () => {
      const content = '# Memory\n\n## Learnings\nEntry 1\nEntry 2\n';
      const section = extractLearningsSection(content);
      expect(section).toContain('Entry 1');
      expect(section).toContain('Entry 2');
    });
  });

  describe('extractExistingKeys', () => {
    it('extracts keys from HTML comment markers', () => {
      const content = `# Memory
## Learnings
<!-- dedup:key1 -->
Entry 1
<!-- dedup:key2 -->
Entry 2
`;
      const keys = extractExistingKeys(content);
      expect(keys).toEqual(['key1', 'key2']);
    });

    it('returns empty array if no keys found', () => {
      const content = '# Memory\n## Learnings\nEntry 1\n';
      expect(extractExistingKeys(content)).toEqual([]);
    });
  });

  describe('formatLearningEntry', () => {
    it('formats entry with dedup key and timestamp', () => {
      const entry: LearningEntry = {
        timestamp: new Date('2024-01-01T00:00:00Z'),
        sessionId: 's1',
        successes: ['success'],
        failures: ['failure'],
        tags: ['tag'],
        toolUsage: [],
      };
      const formatted = formatLearningEntry(entry);
      expect(formatted).toContain('<!-- dedup:');
      expect(formatted).toContain('2024-01-01');
      expect(formatted).toContain('[session:s1]');
    });

    it('includes successes and failures', () => {
      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['used tool'],
        failures: ['error occurred'],
        tags: [],
        toolUsage: [],
      };
      const formatted = formatLearningEntry(entry);
      expect(formatted).toContain('Successes:');
      expect(formatted).toContain('- used tool');
      expect(formatted).toContain('Failures:');
      expect(formatted).toContain('- error occurred');
    });

    it('includes tool usage when present', () => {
      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: [],
        failures: [],
        tags: [],
        toolUsage: [{ tool: 'exec_command', args: 'ls', status: 'success' }],
      };
      const formatted = formatLearningEntry(entry);
      expect(formatted).toContain('Tools:');
      expect(formatted).toContain('exec_command: success');
    });
  });

  describe('appendLearningsToMemory', () => {
    it('creates ## Learnings section if not exists', async () => {
      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['test'],
        failures: [],
        tags: ['test'],
        toolUsage: [],
      };
      await appendLearningsToMemory(memoryPath, [entry]);
      const content = await readFile(memoryPath, 'utf-8');
      expect(content).toContain('## Learnings');
    });

    it('appends entry to existing ## Learnings section', async () => {
      const initialContent = '# Memory\n\n## Learnings\n<!-- dedup:old -->\nOld entry\n';
      await writeFile(memoryPath, initialContent, 'utf-8');

      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's2',
        successes: ['new'],
        failures: [],
        tags: ['new'],
        toolUsage: [],
      };
      await appendLearningsToMemory(memoryPath, [entry]);
      const content = await readFile(memoryPath, 'utf-8');
      expect(content).toContain('old');
      expect(content).toContain('new');
    });

    it('deduplicates entries by dedup_key', async () => {
      const entry1: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['same'],
        failures: ['same-failure'],
        tags: ['same-tag'],
        toolUsage: [],
      };
      await appendLearningsToMemory(memoryPath, [entry1]);

      // Same tags/failures/goal → same dedup key → should be skipped
      const entry2: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's2',
        successes: ['same'],
        failures: ['same-failure'],
        tags: ['same-tag'],
        toolUsage: [],
      };
      const count = await appendLearningsToMemory(memoryPath, [entry2]);
      expect(count).toBe(0);

      const content = await readFile(memoryPath, 'utf-8');
      expect(content).toContain('[session:s1]');
      expect(content).not.toContain('[session:s2]');
    });

    it('returns number of entries appended', async () => {
      const entry: LearningEntry = {
        timestamp: new Date(),
        sessionId: 's1',
        successes: ['test'],
        failures: [],
        tags: ['unique'],
        toolUsage: [],
      };
      const count = await appendLearningsToMemory(memoryPath, [entry]);
      expect(count).toBe(1);
    });
  });
});
