import { describe, expect, it } from 'vitest';
import { parseSuperCommand } from '../../../../src/server/middleware/super-command-parser.js';

describe('super-command-parser @agent behavior', () => {
  it('treats bare <##@agent##> as context switch command', () => {
    const parsed = parseSuperCommand('<##@agent##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('agent');
    expect(parsed.shouldSwitch).toBe(true);
    expect(parsed.targetAgent).toBe('finger-project-agent');
  });

  it('keeps <##@agent:list##> as alias listing command', () => {
    const parsed = parseSuperCommand('<##@agent:list##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('agent_list');
  });
});
