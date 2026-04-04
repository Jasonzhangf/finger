import { describe, expect, it } from 'vitest';
import {
  augmentToolSpecificationsWithCompatAliases,
  buildToolCompatibilityAliases,
  buildToolResolutionCandidates,
} from '../../../src/runtime/tool-compat-aliases.js';

describe('tool compatibility aliases', () => {
  it('builds snake/camel/flat aliases from canonical tool names', () => {
    const aliases = buildToolCompatibilityAliases('agent.list');
    expect(aliases).toContain('agent_list');
    expect(aliases).toContain('agent-list');
    expect(aliases).toContain('agentlist');
    expect(aliases).toContain('agentList');
  });

  it('augments canonical tool specs with compatibility aliases', () => {
    const specs = augmentToolSpecificationsWithCompatAliases([
      { name: 'command.exec', description: 'run command', inputSchema: { type: 'object' } },
      { name: 'reasoning.stop', description: 'stop turn', inputSchema: { type: 'object' } },
    ]);

    const names = specs.map((item) => item.name);
    expect(names).toContain('command.exec');
    expect(names).toContain('command_exec');
    expect(names).toContain('exec_command');
    expect(names).toContain('commandExec');
    expect(names).toContain('reasoning.stop');
    expect(names).toContain('reasoning_stop');
    expect(names).toContain('reasoningStop');
  });

  it('resolves semantic aliases for generic tool names', () => {
    const candidates = buildToolResolutionCandidates('status');
    expect(candidates).toContain('status');
    expect(candidates).toContain('mailbox.status');
    expect(candidates).toContain('heartbeat.status');
    expect(candidates).toContain('project.task.status');
  });
});
