import { describe, expect, it } from 'vitest';
import { createCliCapabilityTool } from '../../../../src/tools/internal/cli-capability-tool.js';

describe('createCliCapabilityTool', () => {
  it('executes capability CLI through spawned process', async () => {
    const tool = createCliCapabilityTool({
      id: 'node-version',
      name: 'Node Version',
      version: '1.0.0',
      description: 'print node version',
      command: 'node',
      defaultArgs: [],
      enabled: true,
    });

    const result = await tool.execute(
      {
        args: ['--version'],
      },
      {
        invocationId: 'test-invocation',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
      },
    ) as {
      ok: boolean;
      exitCode: number;
      stdout: string;
      commandArray: string[];
      capabilityId: string;
    };

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
    expect(result.commandArray[0]).toBe('node');
    expect(result.capabilityId).toBe('node-version');
  });
});
