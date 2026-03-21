import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateTokensForMessages, estimateTokensWithBreakdown } from '../../../src/utils/token-counter.js';

describe('token-counter', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokensForMessages([])).toBe(0);
  });

  it('counts CJK characters as 1 token each', () => {
    const text = '你好世界'; // 4 CJK chars
    const breakdown = estimateTokensWithBreakdown(text);
    expect(breakdown.cjk).toBe(4);
    expect(breakdown.other).toBe(0);
    expect(breakdown.total).toBe(4);
  });

  it('counts non-CJK characters at 1 token per 4 chars (ceil)', () => {
    const text = 'abcd';
    expect(estimateTokens(text)).toBe(1);
    const text2 = 'abcdefgh';
    expect(estimateTokens(text2)).toBe(2);
    const text3 = 'abcdefghi';
    expect(estimateTokens(text3)).toBe(3);
  });

  it('handles mixed CJK and ASCII', () => {
    const text = '你好abcd';
    const breakdown = estimateTokensWithBreakdown(text);
    expect(breakdown.cjk).toBe(2);
    expect(breakdown.other).toBe(4);
    // 2 CJK + ceil(4/4)=1 => 3
    expect(breakdown.total).toBe(3);
  });

  it('estimates tokens for message arrays', () => {
    const messages = [{ content: '你好' }, { content: 'abcd' }, { content: '' }];
    // 2 + 1 + 0 = 3
    expect(estimateTokensForMessages(messages)).toBe(3);
  });
});
