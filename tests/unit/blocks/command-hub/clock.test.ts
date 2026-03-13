/**
 * CommandHub Clock Command Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseCommands } from '../../../../src/blocks/command-hub/parser.js';
import { CommandType } from '../../../../src/blocks/command-hub/types.js';

describe('CommandHub clock command parsing', () => {
  it('should parse clock:list command', () => {
    const input = '<##@system:clock:list##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.CLOCK_LIST);
  });

  it('should parse clock:cancel@id command', () => {
    // clock:cancel syntax uses the param field for timerId
    const input = '<##@system:clock:cancel@timer-123##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.CLOCK_CANCEL);
    // Parser extracts timerId from action, not param
    expect(result.commands[0].params.timerId).toBe('timer-123');
  });

  it('should parse clock:create with JSON payload', () => {
    const json = JSON.stringify({
      message: 'test clock',
      schedule: { type: 'delay', delaySeconds: 60 },
      inject: { agentId: 'agent', prompt: 'task' },
    });
    const input = `<##@system:clock:create@${json}##>`;
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.CLOCK_CREATE);
    expect(result.commands[0].params.message).toBe('test clock');
    expect(result.commands[0].params.schedule.type).toBe('delay');
    expect(result.commands[0].params.inject.agentId).toBe('agent');
  });

  it('should parse clock:create with simple message', () => {
    const input = '<##@system:clock:create@simple message##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.CLOCK_CREATE);
    expect(result.commands[0].params.message).toBe('simple message');
  });

  it('should handle mixed content with clock command', () => {
    const input = 'Hello <##@system:clock:list##> world';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.effectiveContent).toBe('Hello  world');
  });

  it('should reject invalid clock action', () => {
    const input = '<##@system:clock:invalid##>';
    const result = parseCommands(input);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].type).toBe(CommandType.INVALID);
  });
});
