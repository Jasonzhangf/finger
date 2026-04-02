import { describe, it, expect, beforeEach } from 'vitest';
import {
  promptSection,
  volatileSection,
  resolvePromptSections,
  clearPromptCache,
} from '../../src/agents/prompts/sections.js';

describe('PromptSection', () => {
  beforeEach(() => {
    clearPromptCache();
  });

  it('resolves a single cached section', async () => {
    let callCount = 0;
    const section = promptSection('greeting', () => {
      callCount++;
      return 'Hello, world!';
    });

    const result = await resolvePromptSections([section]);
    expect(result).toBe('Hello, world!');
    expect(callCount).toBe(1);
  });

  it('caches section compute on second resolve', async () => {
    let callCount = 0;
    const section = promptSection('counter', () => {
      callCount++;
      return `count:${callCount}`;
    });

    const first = await resolvePromptSections([section]);
    expect(first).toBe('count:1');

    const second = await resolvePromptSections([section]);
    expect(second).toBe('count:1');
    expect(callCount).toBe(1);
  });

  it('volatile section recomputes every resolve', async () => {
    let callCount = 0;
    const section = volatileSection('time', () => {
      callCount++;
      return `tick:${callCount}`;
    }, 'changes every turn');

    const first = await resolvePromptSections([section]);
    expect(first).toBe('tick:1');

    const second = await resolvePromptSections([section]);
    expect(second).toBe('tick:2');
    expect(callCount).toBe(2);
  });

  it('skips null sections', async () => {
    const sections = [
      promptSection('a', () => 'alpha'),
      promptSection('b', () => null),
      promptSection('c', () => 'gamma'),
    ];

    const result = await resolvePromptSections(sections);
    expect(result).toBe('alpha\n\ngamma');
  });

  it('returns empty string when all sections are null', async () => {
    const sections = [
      promptSection('x', () => null),
      promptSection('y', () => null),
    ];

    const result = await resolvePromptSections(sections);
    expect(result).toBe('');
  });

  it('clearPromptCache forces recompute on next resolve', async () => {
    let callCount = 0;
    const section = promptSection('fresh', () => {
      callCount++;
      return `val:${callCount}`;
    });

    await resolvePromptSections([section]);
    expect(callCount).toBe(1);

    clearPromptCache();

    const result = await resolvePromptSections([section]);
    expect(result).toBe('val:2');
    expect(callCount).toBe(2);
  });

  it('supports async compute functions', async () => {
    const section = promptSection('async', async () => {
      return 'async result';
    });

    const result = await resolvePromptSections([section]);
    expect(result).toBe('async result');
  });

  it('mixes cached and volatile sections correctly', async () => {
    let cachedCount = 0;
    let volatileCount = 0;

    const sections = [
      promptSection('static', () => {
        cachedCount++;
        return `static:${cachedCount}`;
      }),
      volatileSection('dynamic', () => {
        volatileCount++;
        return `dynamic:${volatileCount}`;
      }, 'changes per turn'),
    ];

    const first = await resolvePromptSections(sections);
    expect(first).toBe('static:1\n\ndynamic:1');

    const second = await resolvePromptSections(sections);
    expect(second).toBe('static:1\n\ndynamic:2');

    expect(cachedCount).toBe(1);
    expect(volatileCount).toBe(2);
  });
});
