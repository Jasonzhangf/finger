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

  it('parses display command tags with quoted payload', () => {
    const parsed = parseSuperCommand('<##display:"ctx:verbose"##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('display');
    expect(parsed.blocks?.[0]?.content).toBe('ctx:verbose');
    expect(parsed.shouldSwitch).toBe(false);
  });

  it('parses display show command tags', () => {
    const parsed = parseSuperCommand('<##display:"show"##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('display');
    expect(parsed.blocks?.[0]?.content).toBe('show');
    expect(parsed.shouldSwitch).toBe(false);
  });

  it('parses system stop-all command', () => {
    const parsed = parseSuperCommand('<##@system:stopall##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('system');
    expect(parsed.blocks?.[0]?.content).toBe('stop_all_reasoning');
    expect(parsed.shouldSwitch).toBe(true);
    expect(parsed.targetAgent).toBe('finger-system-agent');
  });

  it('parses system progress-reset command', () => {
    const parsed = parseSuperCommand('<##@system:progress:reset##>');
    expect(parsed.type).toBe('super_command');
    expect(parsed.blocks?.[0]?.type).toBe('system');
    expect(parsed.blocks?.[0]?.content).toBe('progress_reset');
    expect(parsed.shouldSwitch).toBe(true);
    expect(parsed.targetAgent).toBe('finger-system-agent');
  });
});
