import { describe, expect, it } from 'vitest';
import { inferTagsAndTopic } from '../../src/common/tag-topic-inference.js';

describe('inferTagsAndTopic', () => {
  it('infers topic and tags from context-builder keywords', () => {
    const result = inferTagsAndTopic({
      texts: ['需要重组上下文，context builder 在多话题下有帮助'],
      seedTags: ['finger-system-agent'],
    });

    expect(result.topic).toBe('context-builder');
    expect(result.tags).toContain('context-builder');
    expect(result.tags).toContain('history-rebuild');
    expect(result.tags).toContain('finger-system-agent');
  });

  it('extracts explicit hash tags', () => {
    const result = inferTagsAndTopic({
      texts: ['请处理 #mailbox 和 #dispatch 的问题'],
    });

    expect(result.tags).toEqual(expect.arrayContaining(['mailbox', 'dispatch']));
  });

  it('respects existing topic when provided', () => {
    const result = inferTagsAndTopic({
      texts: ['修复 qqbot 链路'],
      seedTopic: 'custom-topic',
    });

    expect(result.topic).toBe('custom-topic');
  });
});

