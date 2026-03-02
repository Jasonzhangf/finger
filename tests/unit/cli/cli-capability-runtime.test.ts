import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCliCapability } from '../../../src/cli/cli-capability-loader.js';

describe('cli capability runtime execution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes capability execution through daemon tool API by default', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          ok: true,
          exitCode: 0,
          stdout: 'ok\n',
          stderr: '',
          timedOut: false,
          durationMs: 10,
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const exitCode = await executeCliCapability(
      {
        id: 'bd',
        name: 'BD Task CLI',
        version: '1.0.0',
        description: 'bd cli',
        command: 'bd',
        enabled: true,
      },
      ['--no-db', 'list'],
      {
        daemonUrl: 'http://localhost:5521',
        agentId: 'manual-cli',
      },
    );

    expect(exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, rawRequest] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(rawRequest.body)) as {
      agentId: string;
      toolName: string;
      input: { args: string[] };
    };

    expect(body.agentId).toBe('manual-cli');
    expect(body.toolName).toBe('capability.bd');
    expect(body.input.args).toEqual(['--no-db', 'list']);
  });
});
