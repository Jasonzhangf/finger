import { describe, expect, it } from 'vitest';
import { sanitizeDispatchResult } from '../../src/common/agent-dispatch.js';

describe('sanitizeDispatchResult - tags extraction', () => {
  it('extracts tags from top-level raw.tags array', () => {
    const raw = {
      summary: '审查完成',
      tags: ['review', 'code-quality', 'bug-fix'],
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['review', 'code-quality', 'bug-fix']);
    expect(result.rawPayload).toBeDefined();
  });

  it('extracts tags from nested response.tags', () => {
    const raw = {
      response: JSON.stringify({ summary: 'Done', tags: ['deploy', 'release'] }),
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['deploy', 'release']);
  });

  it('deduplicates tags across sources', () => {
    const raw = {
      tags: ['review', 'bug-fix'],
      response: JSON.stringify({ tags: ['review', 'new-tag'] }),
      topic: 'code-review',
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['review', 'bug-fix', 'new-tag', 'code-review']);
    expect(result.topic).toBe('code-review');
  });

  it('uses topic as a tag source', () => {
    const raw = {
      summary: 'Done',
      topic: 'infrastructure',
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['infrastructure']);
    expect(result.topic).toBe('infrastructure');
  });

  it('extracts topic from nested response', () => {
    const raw = {
      response: JSON.stringify({ summary: 'Done', topic: 'web-auto' }),
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.topic).toBe('web-auto');
    expect(result.tags).toEqual(['web-auto']);
  });

  it('prefers top-level topic over nested topic', () => {
    const raw = {
      topic: 'top-level-topic',
      response: JSON.stringify({ topic: 'nested-topic' }),
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.topic).toBe('top-level-topic');
  });

  it('ignores tags with empty or overly long entries', () => {
    const raw = {
      summary: 'Done',
      tags: ['', 'valid-tag', '   ', 'x'.repeat(51), 'another-valid'],
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['valid-tag', 'another-valid']);
  });

  it('handles non-string tag entries gracefully', () => {
    const raw = {
      summary: 'Done',
      tags: ['valid', 123, null, undefined, { invalid: true }, 'also-valid'],
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toEqual(['valid', 'also-valid']);
  });

  it('returns no tags when no tag sources present', () => {
    const raw = { summary: 'Simple summary' };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toBeUndefined();
    expect(result.topic).toBeUndefined();
  });

  it('returns no tags when all tag sources are empty arrays', () => {
    const raw = { summary: 'Done', tags: [] };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.tags).toBeUndefined();
  });

  it('preserves rawPayload with tags intact for ledger', () => {
    const raw = {
      summary: 'Review done',
      tags: ['review'],
      issues: [{ title: 'issue-1', detail: 'x'.repeat(5000) }],
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.rawPayload).toBeDefined();
    expect((result.rawPayload as any).tags).toEqual(['review']);
    expect((result.rawPayload as any).issues[0].detail.length).toBe(5000);
  });

  it('normalizes evidence tags', () => {
    const raw = {
      summary: 'Done',
      evidence: [
        { tool: 'rg', detail: 'found 3 matches', tags: ['search', 'file-search'] },
        { tool: 'cat', detail: 'read file' },
      ],
    };
    const result = sanitizeDispatchResult(raw as any);
    expect(result.evidence).toBeDefined();
    expect(result.evidence![0].tags).toEqual(['search', 'file-search']);
    expect(result.evidence![1].tags).toBeUndefined();
  });
});
