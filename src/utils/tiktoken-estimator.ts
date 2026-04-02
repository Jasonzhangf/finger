import { encodingForModel, getEncoding, type Tiktoken, type TiktokenModel } from 'js-tiktoken';
import { logger } from '../core/logger.js';

const log = logger.module('TiktokenEstimator');
const CJK_CHAR_REGEX = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u;

let cachedTokenizer: Tiktoken | null = null;
let tokenizerInitFailed = false;

function heuristicEstimate(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    if (CJK_CHAR_REGEX.test(char)) cjkCount += 1;
    else otherCount += 1;
  }
  return cjkCount + (otherCount > 0 ? Math.ceil(otherCount / 4) : 0);
}

function resolveTokenizer(): Tiktoken | null {
  if (cachedTokenizer) return cachedTokenizer;
  if (tokenizerInitFailed) return null;
  try {
    const preferredModel = typeof process.env.FINGER_TIKTOKEN_MODEL === 'string'
      && process.env.FINGER_TIKTOKEN_MODEL.trim().length > 0
      ? process.env.FINGER_TIKTOKEN_MODEL.trim()
      : 'gpt-4o-mini';
    // js-tiktoken type only accepts known model literals.
    // We still allow env override (runtime-validated by try/catch).
    cachedTokenizer = encodingForModel(preferredModel as TiktokenModel);
    return cachedTokenizer;
  } catch {
    try {
      cachedTokenizer = getEncoding('o200k_base');
      return cachedTokenizer;
    } catch (error) {
      tokenizerInitFailed = true;
      log.warn('Failed to initialize tiktoken encoder, fallback to heuristic token estimate', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/**
 * Estimate token count with tiktoken (fallback to heuristic when unavailable).
 */
export function estimateTokensWithTiktoken(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const tokenizer = resolveTokenizer();
  if (!tokenizer) return heuristicEstimate(text);
  try {
    const encoded = tokenizer.encode(text);
    return Array.isArray(encoded) ? encoded.length : 0;
  } catch (error) {
    log.warn('tiktoken encode failed, fallback to heuristic token estimate', {
      error: error instanceof Error ? error.message : String(error),
    });
    return heuristicEstimate(text);
  }
}
