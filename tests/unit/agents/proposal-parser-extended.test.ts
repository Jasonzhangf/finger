import { describe, it, expect } from 'vitest';
import { parseActionProposal } from '../../../src/agents/runtime/proposal-parser.js';

describe('parseActionProposal extended mask/repair', () => {
  it('extracts JSON object from noisy text', () => {
    const raw = 'prefix text\n{"thought":"x","action":"WRITE_FILE","params":{"path":"a.txt","content":"ok"}}\nsuffix';
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.proposal?.action).toBe('WRITE_FILE');
  });

  it('repairs unquoted keys and single quoted strings', () => {
    const raw = "{ thought: 'fix', action: 'SHELL_EXEC', params: { command: 'ls -la' } }";
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('repaired');
    expect(result.proposal?.params.command).toBe('ls -la');
  });

  it('repairs chinese punctuation', () => {
    const raw = '{"thought"："中文"，"action":"READ_FILE"，"params":{}}';
    const result = parseActionProposal(raw);
    expect(result.success).toBe(true);
    expect(result.method).toBe('repaired');
    expect(result.proposal?.action).toBe('READ_FILE');
  });

  it('fails with clear error when no json candidate exists', () => {
    const result = parseActionProposal('no json here, please retry format');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
