import { describe, it, expect } from 'vitest';
import { parseActionProposal } from '../../../src/agents/runtime/proposal-parser.js';

describe('parseActionProposal', () => {
  it('should parse clean JSON directly', () => {
    const raw = JSON.stringify({
      thought: 'test thought',
      action: 'SHELL_EXEC',
      params: { command: 'ls' },
    });
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('masked');
    expect(result.proposal?.action).toBe('SHELL_EXEC');
  });

  it('should extract JSON from markdown code block', () => {
    const raw = `Some text before\n\`\`\`json\n{"thought":"t","action":"A","params":{}}\n\`\`\`\nAfter`;
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('masked');
  });

  it('should repair single-quoted keys', () => {
    const raw = "{ thought: 't', action: 'A', params: {} }";
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('repaired');
    expect(result.proposal?.action).toBe('A');
  });

  it('should repair trailing commas', () => {
    const raw = '{"a":1,}';
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('repaired');
  });

  it('should fail gracefully on invalid input', () => {
    const result = parseActionProposal('not json at all');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should normalize unicode quotes', () => {
    const raw = '{"thought": "使用中文引号“测试”", "action": "TEST", "params": {}}';
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
  });
});
