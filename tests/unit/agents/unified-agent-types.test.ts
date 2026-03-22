import { describe, expect, it } from 'vitest';
import { mergeHistory, parseUnifiedAgentInput } from '../../../src/agents/base/unified-agent-types.js';

describe('unified-agent-types', () => {
  it('parses string input as text', () => {
    const parsed = parseUnifiedAgentInput('hello');
    expect(parsed).toEqual({ text: 'hello' });
  });

  it('parses alias input fields and trims values', () => {
    const parsed = parseUnifiedAgentInput({
      prompt: '  hello from prompt  ',
      sessionId: 's1',
      tools: ['shell', 'shell', ''],
    });

    expect(parsed).toEqual({
      text: 'hello from prompt',
      sessionId: 's1',
      createNewSession: undefined,
      sender: undefined,
      history: undefined,
      metadata: undefined,
      roleProfile: undefined,
      tools: ['shell'],
    });
  });

  it('falls back to metadata.sessionId when top-level sessionId is missing', () => {
    const parsed = parseUnifiedAgentInput({
      content: 'hello',
      metadata: { sessionId: 's-meta' },
    });

    expect(parsed).toEqual({
      text: 'hello',
      sessionId: 's-meta',
      createNewSession: undefined,
      sender: undefined,
      history: undefined,
      metadata: { sessionId: 's-meta' },
      roleProfile: undefined,
      tools: undefined,
    });
  });

  it('throws when top-level sessionId conflicts with metadata.sessionId', () => {
    expect(() => parseUnifiedAgentInput({
      content: 'hello',
      sessionId: 's-top',
      metadata: { sessionId: 's-meta' },
    })).toThrow('Conflicting sessionId sources');
  });

  it('returns null for empty payload', () => {
    expect(parseUnifiedAgentInput({ foo: 'bar' })).toBeNull();
    expect(parseUnifiedAgentInput('   ')).toBeNull();
  });

  it('supports task field used by CLI execute payloads', () => {
    const parsed = parseUnifiedAgentInput({
      type: 'EXECUTE',
      task: '  run heartbeat e2e  ',
      sessionId: 's-heartbeat',
    });

    expect(parsed).toEqual({
      text: 'run heartbeat e2e',
      sessionId: 's-heartbeat',
      createNewSession: undefined,
      sender: undefined,
      history: undefined,
      metadata: undefined,
      roleProfile: undefined,
      tools: undefined,
    });
  });

  it('prefers explicit history when provided', () => {
    const merged = mergeHistory(
      [
        {
          id: 'm1',
          role: 'user',
          content: 'session history',
          timestamp: new Date().toISOString(),
        },
      ],
      [
        {
          role: 'assistant',
          content: 'external history',
        },
      ],
      20,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('external history');
    expect(merged[0].role).toBe('assistant');
  });
});
