/**
 * Session Fork History Inheritance
 *
 * Provides history filtering and truncation utilities for forking sessions.
 * Inspired by Codex `control.rs:96-120` `keep_forked_rollout_item`.
 *
 * Module: session-fork
 * Layer: orchestration
 */

import { logger } from '../core/logger.js';

const log = logger.module('session-fork');

// ─── Types ────────────────────────────────────────────────

export enum ForkMode {
  FullHistory = 'full',
  LastNTurns = 'last_n',
}

export interface ForkOptions {
  mode: ForkMode;
  lastNTurns?: number; // only for LastNTurns mode, default 5
}

export interface HistoryItem {
  type: 'message' | 'tool_call' | 'tool_output' | 'reasoning' | 'compacted' | 'event_msg' | 'session_meta';
  role?: 'system' | 'user' | 'assistant' | 'developer';
  phase?: 'final_answer' | 'intermediate';
  content: unknown;
  timestamp?: string;
}

// ──�� Single-item filter ───────────────────────────────────

/**
 * Determines whether a single history item should be kept in a forked session.
 *
 * Rules (borrowed from Codex):
 *   - message with system/user/developer role → keep
 *   - message with assistant + final_answer phase → keep
 *   - message with assistant + intermediate phase → drop
 *   - tool_call / tool_output / reasoning → drop
 *   - compacted / event_msg / session_meta → keep
 */
export function keepForkedRolloutItem(item: HistoryItem): boolean {
  switch (item.type) {
    case 'message': {
      if (item.role === 'assistant') {
        return item.phase === 'final_answer';
      }
      // system, user, developer → always keep
      return true;
    }
    case 'compacted':
    case 'event_msg':
    case 'session_meta':
      return true;
    case 'tool_call':
    case 'tool_output':
    case 'reasoning':
      return false;
    default:
      // Unknown types are dropped to avoid leaking internal state
      return false;
  }
}

// ─── Turn-based truncation ────────────────────────────────

/**
 * A "turn" ends when we encounter an assistant final_answer message
 * or a new user message (whichever comes first from the end).
 *
 * We walk forward, counting turn boundaries (user messages and
 * assistant final_answers). When the count exceeds n, we slice
 * from that boundary to preserve whole turns only.
 */
export function truncateToLastNTurns(history: HistoryItem[], n: number): HistoryItem[] {
  if (n <= 0 || history.length === 0) return [];

  let turnCount = 0;
  let cutIndex = 0;

  // Walk forward, detecting turn boundaries.
  // A turn boundary = user message OR assistant final_answer.
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    const isTurnBoundary =
      (item.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer') ||
      (item.type === 'message' && item.role === 'user');

    if (isTurnBoundary) {
      turnCount++;
      if (turnCount > n) {
        // This is boundary (n+1) — everything from here onward starts the excess.
        cutIndex = i;
      }
    }
  }

  // If we never exceeded n turns, keep everything
  if (turnCount <= n) {
    return history;
  }

  const truncated = history.slice(cutIndex);
  log.debug('truncateToLastNTurns', { n, turnCount, cutIndex, kept: truncated.length, total: history.length });
  return truncated;
}

// ─── Main entry point ─────────────────────────────────────

/**
 * Fork session history according to the given options.
 *
 * FullHistory: apply keepForkedRolloutItem filter to entire history.
 * LastNTurns: first truncate to last N turns, then apply filter.
 */
export function forkSessionHistory(
  history: HistoryItem[],
  options: ForkOptions,
): HistoryItem[] {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  let working: HistoryItem[];

  switch (options.mode) {
    case ForkMode.LastNTurns: {
      const n = options.lastNTurns ?? 5;
      working = truncateToLastNTurns(history, n);
      break;
    }
    case ForkMode.FullHistory:
    default:
      working = history;
      break;
  }

  const result = working.filter(keepForkedRolloutItem);

  log.info('forkSessionHistory completed', {
    mode: options.mode,
    inputLength: history.length,
    outputLength: result.length,
  });

  return result;
}
