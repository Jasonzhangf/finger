import { describe, expect, it } from 'vitest';
import { parseCommands } from '../../../../src/blocks/command-hub/parser.js';
import { CommandType } from '../../../../src/blocks/command-hub/types.js';

describe('CommandHub agent command parsing', () => {
  it('parses bare <##@agent##> as AGENT switch command', () => {
    const result = parseCommands('<##@agent##>');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AGENT);
  });

  it('parses <##@agent:list##> as AGENT_LIST command', () => {
    const result = parseCommands('<##@agent:list##>');
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.AGENT_LIST);
  });
});
