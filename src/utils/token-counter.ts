/**
 * Token counter utilities (heuristic estimation)
 *
 * - CJK/Hangul/Hiragana/Katakana: count 1 token per character
 * - Other characters: 1 token per ~4 chars (ceil)
 *
 * This is a heuristic estimator, not a tokenizer.
 */

const CJK_CHAR_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u;

export interface TokenEstimateBreakdown {
  total: number;
  cjk: number;
  other: number;
}

export function estimateTokens(text: string): number {
  return estimateTokensWithBreakdown(text).total;
}

export function estimateTokensWithBreakdown(text: string): TokenEstimateBreakdown {
  if (!text || typeof text !== 'string') {
    return { total: 0, cjk: 0, other: 0 };
  }

  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    if (CJK_CHAR_REGEX.test(char)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }

  const otherTokens = Math.ceil(otherCount / 4);
  const total = cjkCount + (otherCount > 0 ? otherTokens : 0);

  return {
    total,
    cjk: cjkCount,
    other: otherCount,
  };
}

export function estimateTokensForMessages(messages: Array<{ content?: string }>): number {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  return messages.reduce((sum, msg) => sum + estimateTokens(msg.content ?? ''), 0);
}
