import { describe, it, expect } from 'vitest';
import {
  parseSummaryBlocks,
  hasSummaryBlock,
  stripSummaryBlocks,
  formatSummaryForDisplay,
  extractAndFormatSummaries,
} from '../../../../../src/tools/internal/memory/summary-parser.js';

describe('SummaryParser', () => {
  describe('parseSummaryBlocks', () => {
    it('should parse a valid summary block', () => {
      const text = `Some output here.

<memory_summary>
[type]: discovery
[title]: Found race condition
[content]:
In AuthModule.ts:142 there is a race condition.
Fixed by adding mutex.
[tags]: bug, auth, fixed
</memory_summary>

More output.`;

      const results = parseSummaryBlocks(text);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('discovery');
      expect(results[0].title).toBe('Found race condition');
      expect(results[0].content).toContain('race condition');
      expect(results[0].tags).toEqual(['bug', 'auth', 'fixed']);
    });

    it('should parse multiple summary blocks', () => {
      const text = `
<memory_summary>
[type]: fact
[title]: Fact 1
[content]:
Content 1
[tags]: tag1
</memory_summary>

<memory_summary>
[type]: decision
[title]: Decision 1
[content]:
Content 2
[tags]: tag2
</memory_summary>
`;

      const results = parseSummaryBlocks(text);

      expect(results).toHaveLength(2);
      expect(results[0].type).toBe('fact');
      expect(results[1].type).toBe('decision');
    });

    it('should ignore blocks with invalid type', () => {
      const text = `
<memory_summary>
[type]: invalid_type
[title]: Test
[content]:
Content
[tags]: tag
</memory_summary>
`;

      const results = parseSummaryBlocks(text);

      expect(results).toHaveLength(0);
    });

    it('should handle missing tags field', () => {
      const text = `
<memory_summary>
[type]: fact
[title]: No tags
[content]:
Just content, no tags field
</memory_summary>
`;

      const results = parseSummaryBlocks(text);

      expect(results).toHaveLength(1);
      expect(results[0].tags).toEqual([]);
    });
  });

  describe('hasSummaryBlock', () => {
    it('should return true when block exists', () => {
      const text = `
<memory_summary>
[type]: fact
[title]: Test
[content]:
Content
</memory_summary>
`;
      expect(hasSummaryBlock(text)).toBe(true);
    });

    it('should return false when no block', () => {
      expect(hasSummaryBlock('No block here')).toBe(false);
    });
  });

  describe('stripSummaryBlocks', () => {
    it('should remove summary blocks from text', () => {
      const text = `Before.

<memory_summary>
[type]: fact
[title]: Test
[content]:
Content
</memory_summary>

After.`;

      const stripped = stripSummaryBlocks(text);

      expect(stripped).toBe('Before.\n\nAfter.');
      expect(stripped).not.toContain('<memory_summary>');
    });
  });

  describe('formatSummaryForDisplay', () => {
    it('should format summary with emoji and tags', () => {
      const summary = {
        type: 'discovery' as const,
        title: 'Found bug',
        content: 'Bug details here',
        tags: ['bug', 'auth'],
      };

      const display = formatSummaryForDisplay(summary);

      expect(display).toContain('💡');
      expect(display).toContain('**Found bug**');
      expect(display).toContain('[bug, auth]');
      expect(display).toContain('Bug details here');
    });

    it('should handle no tags', () => {
      const summary = {
        type: 'fact' as const,
        title: 'Fact',
        content: 'Content',
        tags: [],
      };

      const display = formatSummaryForDisplay(summary);

      expect(display).toContain('📌');
      expect(display).not.toContain('[]');
    });
  });

  describe('extractAndFormatSummaries', () => {
    it('should extract, format and clean', () => {
      const text = `Output text.

<memory_summary>
[type]: fact
[title]: Important fact
[content]:
This is important
[tags]: important
</memory_summary>

End text.`;

      const result = extractAndFormatSummaries(text);

      expect(result.summaries).toHaveLength(1);
      expect(result.cleaned).not.toContain('<memory_summary>');
      expect(result.cleaned).toContain('Output text.');
      expect(result.cleaned).toContain('End text.');
      expect(result.display).toContain('📌');
      expect(result.display).toContain('**Important fact**');
    });

    it('should return empty display when no summaries', () => {
      const result = extractAndFormatSummaries('No summaries here');

      expect(result.display).toBe('');
      expect(result.summaries).toHaveLength(0);
      expect(result.cleaned).toBe('No summaries here');
    });
  });
});
