import { describe, expect, it } from 'vitest';

describe('context-builder tag extraction', () => {
  it('TaskBlock type includes tags and topic fields', async () => {
    const mod = await import('../../src/runtime/context-builder-types.js');
    // Verify the type interface has tags and topic (compile-time check only)
    const _block: import('../../src/runtime/context-builder-types.js').TaskBlock = {
      id: 'test',
      startTime: 0,
      endTime: 0,
      startTimeIso: '',
      endTimeIso: '',
      messages: [],
      tokenCount: 0,
      tags: ['test-tag'],
      topic: 'test-topic',
    };
    expect(_block.tags).toEqual(['test-tag']);
    expect(_block.topic).toBe('test-topic');
  });

  it('context builder exports buildContext function', async () => {
    const mod = await import('../../src/runtime/context-builder.js');
    expect(typeof mod.buildContext).toBe('function');
  });
});

describe('context-builder tag-aware ranking prompt', () => {
  it('ranking prompt includes tag matching as highest priority', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/runtime/context-builder.ts', 'utf8');
    
    expect(content).toContain('标签匹配（最高优先级）');
    expect(content).toContain('排序原则（三重维度）');
    expect(content).toContain('tags（分类标签）');
    expect(content).toContain('topic（主题）');
    expect(content).toContain('标签匹配：task 的 tags/topic 是否与当前问题相关（最高优先）');
    expect(content).toContain('const tagsLine = b.tags');
    expect(content).toContain('const topicLine = b.topic');
  });
});

describe('agent-dispatch tag normalization', () => {
  it('does not limit tag string length', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync('src/common/agent-dispatch.ts', 'utf8');
    expect(content).not.toContain('entry.length <= 50');
    expect(content).toContain('entry.trim().length > 0');
  });
});
