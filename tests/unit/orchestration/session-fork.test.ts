import { describe, expect, it } from 'vitest';
import {
  ForkMode,
  forkSessionHistory,
  keepForkedRolloutItem,
  truncateToLastNTurns,
  type HistoryItem,
} from '../../../src/orchestration/session-fork.js';

// ─── Helpers ──────────────────────────────────────────────

const msg = (
  role: HistoryItem['role'],
  content: string,
  phase?: HistoryItem['phase'],
): HistoryItem => ({ type: 'message', role, phase, content });

const item = (type: HistoryItem['type'], content?: unknown): HistoryItem => ({
  type,
  content: content ?? `(${type})`,
});

// ─── keepForkedRolloutItem ────────────────────────────────

describe('keepForkedRolloutItem', () => {
  it('keeps system messages', () => {
    expect(keepForkedRolloutItem(msg('system', 'sys prompt'))).toBe(true);
  });

  it('keeps user messages', () => {
    expect(keepForkedRolloutItem(msg('user', 'hello'))).toBe(true);
  });

  it('keeps developer messages', () => {
    expect(keepForkedRolloutItem(msg('developer', 'directive'))).toBe(true);
  });

  it('keeps assistant final_answer messages', () => {
    expect(keepForkedRolloutItem(msg('assistant', 'result', 'final_answer'))).toBe(true);
  });

  it('drops assistant intermediate messages', () => {
    expect(keepForkedRolloutItem(msg('assistant', 'thinking...', 'intermediate'))).toBe(false);
  });

  it('drops tool_call items', () => {
    expect(keepForkedRolloutItem(item('tool_call', { fn: 'read' }))).toBe(false);
  });

  it('drops tool_output items', () => {
    expect(keepForkedRolloutItem(item('tool_output', 'file contents'))).toBe(false);
  });

  it('drops reasoning items', () => {
    expect(keepForkedRolloutItem(item('reasoning', 'chain of thought'))).toBe(false);
  });

  it('keeps compacted items', () => {
    expect(keepForkedRolloutItem(item('compacted', 'summary'))).toBe(true);
  });

  it('keeps event_msg items', () => {
    expect(keepForkedRolloutItem(item('event_msg', 'spawn'))).toBe(true);
  });

  it('keeps session_meta items', () => {
    expect(keepForkedRolloutItem(item('session_meta', { id: 'abc' }))).toBe(true);
  });

  it('drops unknown types (safety)', () => {
    // Cast to bypass TS — simulates runtime data from external sources
    expect(keepForkedRolloutItem({ type: 'unknown_type' as HistoryItem['type'], content: 'x' })).toBe(false);
  });
});

// ─── truncateToLastNTurns ─────────────────────────────────

describe('truncateToLastNTurns', () => {
  it('returns empty for empty history', () => {
    expect(truncateToLastNTurns([], 3)).toEqual([]);
  });

  it('returns empty for n=0', () => {
    const history = [msg('user', 'hi'), msg('assistant', 'hey', 'final_answer')];
    expect(truncateToLastNTurns(history, 0)).toEqual([]);
  });

  it('returns full history when n >= turn count', () => {
    const history = [
      msg('user', 'q1'),
      msg('assistant', 'a1', 'final_answer'),
      msg('user', 'q2'),
      msg('assistant', 'a2', 'final_answer'),
    ];
    expect(truncateToLastNTurns(history, 5)).toEqual(history);
  });

  it('truncates to last N turns correctly', () => {
    // 3 turns: each = user + assistant final_answer
    const history = [
      msg('user', 'q1'),
      msg('assistant', 'a1', 'final_answer'),
      msg('user', 'q2'),
      msg('assistant', 'a2', 'final_answer'),
      msg('user', 'q3'),
      msg('assistant', 'a3', 'final_answer'),
    ];

    const result = truncateToLastNTurns(history, 2);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContainEqual(msg('assistant', 'a3', 'final_answer'));
  });

  it('preserves system messages at start when history fits', () => {
    const history = [
      msg('system', 'sys'),
      msg('user', 'q1'),
      msg('assistant', 'a1', 'final_answer'),
    ];
    expect(truncateToLastNTurns(history, 5)).toEqual(history);
  });

  it('does not split mid-turn (keeps complete turns)', () => {
    const history = [
      msg('user', 'q1'),
      msg('assistant', 'thinking', 'intermediate'),
      item('tool_call', 'read'),
      item('tool_output', 'data'),
      msg('assistant', 'a1', 'final_answer'),
      msg('user', 'q2'),
      msg('assistant', 'a2', 'final_answer'),
    ];

    const result = truncateToLastNTurns(history, 1);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── forkSessionHistory ───────────────────────────────────

describe('forkSessionHistory', () => {
  const sampleHistory: HistoryItem[] = [
    msg('system', 'system prompt'),
    msg('user', 'q1'),
    msg('assistant', 'thinking', 'intermediate'),
    item('tool_call', { fn: 'read' }),
    item('tool_output', 'file data'),
    msg('assistant', 'a1', 'final_answer'),
    item('compacted', 'summary of earlier'),
    msg('user', 'q2'),
    item('reasoning', 'chain of thought'),
    msg('assistant', 'a2', 'final_answer'),
  ];

  it('FullHistory mode filters out tool_calls, reasoning, intermediate', () => {
    const result = forkSessionHistory(sampleHistory, { mode: ForkMode.FullHistory });
    expect(result).toHaveLength(6);
    expect(result.every(keepForkedRolloutItem)).toBe(true);
    const types = result.map(r => r.type);
    expect(types).not.toContain('tool_call');
    expect(types).not.toContain('tool_output');
    expect(types).not.toContain('reasoning');
    const assistants = result.filter(r => r.role === 'assistant');
    expect(assistants).toHaveLength(2);
    assistants.forEach(a => expect(a.phase).toBe('final_answer'));
  });

  it('LastNTurns mode truncates then filters', () => {
    const result = forkSessionHistory(sampleHistory, {
      mode: ForkMode.LastNTurns,
      lastNTurns: 2,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(keepForkedRolloutItem)).toBe(true);
  });

  it('LastNTurns defaults to 5 when lastNTurns not specified', () => {
    const smallHistory: HistoryItem[] = [
      msg('user', 'q1'),
      msg('assistant', 'a1', 'final_answer'),
    ];
    const result = forkSessionHistory(smallHistory, { mode: ForkMode.LastNTurns });
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty history', () => {
    expect(forkSessionHistory([], { mode: ForkMode.FullHistory })).toEqual([]);
  });

  it('handles history with only filterable items', () => {
    const allFiltered: HistoryItem[] = [
      item('tool_call', 'x'),
      item('tool_output', 'y'),
      item('reasoning', 'z'),
      msg('assistant', 'mid', 'intermediate'),
    ];
    const result = forkSessionHistory(allFiltered, { mode: ForkMode.FullHistory });
    expect(result).toEqual([]);
  });

  it('preserves event_msg and session_meta', () => {
    const history: HistoryItem[] = [
      item('event_msg', 'agent_spawned'),
      item('session_meta', { id: '123' }),
      msg('user', 'hi'),
    ];
    const result = forkSessionHistory(history, { mode: ForkMode.FullHistory });
    expect(result).toHaveLength(3);
  });

  it('preserves compacted items', () => {
    const history: HistoryItem[] = [
      item('compacted', 'earlier summary'),
      msg('user', 'q1'),
      msg('assistant', 'a1', 'final_answer'),
    ];
    const result = forkSessionHistory(history, { mode: ForkMode.FullHistory });
    expect(result).toHaveLength(3);
  });

  it('handles non-array input gracefully', () => {
    expect(forkSessionHistory(null as unknown as HistoryItem[], { mode: ForkMode.FullHistory })).toEqual([]);
    expect(forkSessionHistory(undefined as unknown as HistoryItem[], { mode: ForkMode.FullHistory })).toEqual([]);
  });
});
