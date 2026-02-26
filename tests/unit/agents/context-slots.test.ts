import { describe, expect, it } from 'vitest';
import { composeTurnContextSlots } from '../../../src/agents/base/context-slots.js';

describe('context slots', () => {
  it('renders base slots with user input/history/tools', () => {
    const result = composeTurnContextSlots({
      cacheKey: 's1',
      userInput: 'please run tests',
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      tools: ['shell.exec', 'apply_patch'],
    });

    expect(result).toBeDefined();
    expect(result?.slotIds).toEqual(['turn.user_input', 'turn.recent_history', 'turn.allowed_tools']);
    expect(result?.rendered).toContain('<slot id="turn.user_input">');
    expect(result?.rendered).toContain('[user] hello');
    expect(result?.rendered).toContain('- shell.exec');
  });

  it('supports replace and trim for per-turn patches', () => {
    const result = composeTurnContextSlots({
      cacheKey: 's2',
      userInput: 'u',
      history: [],
      tools: ['shell.exec'],
      metadata: {
        contextSlots: [
          { id: 'turn.allowed_tools', mode: 'replace', content: 'shell.exec only', maxChars: 12 },
          { id: 'custom.note', mode: 'replace', content: 'external slot', priority: 15 },
        ],
        contextSlotOrder: ['turn.user_input', 'custom.note', 'turn.allowed_tools'],
      },
    });

    expect(result).toBeDefined();
    expect(result?.slotIds).toEqual(['turn.user_input', 'custom.note', 'turn.allowed_tools']);
    expect(result?.trimmedSlotIds).toContain('turn.allowed_tools');
    expect(result?.rendered).toContain('<slot id="custom.note">');
  });

  it('recomputes output when dirty signature changes', () => {
    const first = composeTurnContextSlots({
      cacheKey: 's3',
      userInput: 'step1',
      history: [],
      tools: ['shell.exec'],
    });
    const second = composeTurnContextSlots({
      cacheKey: 's3',
      userInput: 'step2',
      history: [],
      tools: ['shell.exec'],
    });

    expect(first?.rendered).not.toBe(second?.rendered);
    expect(second?.rendered).toContain('step2');
  });
});

