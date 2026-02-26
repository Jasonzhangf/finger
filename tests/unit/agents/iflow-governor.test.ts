import { describe, expect, it, vi } from 'vitest';
import { resolveIflowGovernance } from '../../../src/agents/sdk/iflow-governor.js';

vi.mock('../../../src/tools/external/cli-capability-registry.js', () => ({
  resolveAvailableCliCapabilities: () => [
    {
      id: 'bd',
      name: 'BD Task CLI',
      version: '1.0.0',
      description: 'task manager',
      command: 'bd',
      defaultArgs: ['--no-db'],
    },
    {
      id: 'camo',
      name: 'Camoufox',
      version: '1.0.0',
      description: 'browser automation',
      command: 'camo',
      defaultArgs: ['run'],
    },
  ],
}));

describe('iflow-governor', () => {
  it('merges tool policy into session settings', () => {
    const resolved = resolveIflowGovernance(
      {
        sessionSettings: {
          add_dirs: ['/workspace'],
        },
      },
      {
        toolPolicy: {
          allowedTools: ['read_file', 'write_file', 'read_file'],
          disallowedTools: ['shell'],
          approvalMode: 'default',
        },
      },
    );

    expect(resolved.sessionSettings).toEqual({
      add_dirs: ['/workspace'],
      allowed_tools: ['read_file', 'write_file'],
      disallowed_tools: ['shell'],
      permission_mode: 'default',
    });
  });

  it('injects selected cli capabilities as commands', () => {
    const resolved = resolveIflowGovernance(
      {
        commands: [{ name: 'existing', content: 'echo existing' }],
      },
      {
        commandPolicy: {
          injectCapabilities: true,
          capabilityIds: ['bd'],
          commandNamespace: 'cap_',
        },
      },
    );

    expect(resolved.commands).toBeDefined();
    expect(resolved.commands).toEqual(
      expect.arrayContaining([
        { name: 'existing', content: 'echo existing' },
        { name: 'cap_bd', content: 'bd --no-db' },
      ]),
    );
    expect(resolved.injectedCommands).toHaveLength(1);
    expect(resolved.injectedCommands[0]).toMatchObject({
      capabilityId: 'bd',
      commandName: 'cap_bd',
      commandLine: 'bd --no-db',
    });
  });
});
