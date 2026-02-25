import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { registerToolCommand } from '../../../src/cli/tool-command.js';

describe('tool command', () => {
  it('registers tool command tree', () => {
    const program = new Command();
    registerToolCommand(program);

    const tool = program.commands.find((cmd) => cmd.name() === 'tool');
    expect(tool).toBeDefined();
    expect(tool?.commands.some((cmd) => cmd.name() === 'list')).toBe(true);
    expect(tool?.commands.some((cmd) => cmd.name() === 'shell')).toBe(true);
    expect(tool?.commands.some((cmd) => cmd.name() === 'run')).toBe(true);
  });
});
