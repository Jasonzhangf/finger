import { describe, expect, it } from 'vitest';
import { execCommandTool, writeStdinTool } from '../../../../src/tools/internal/codex-exec-tools.js';

const TEST_CONTEXT = {
  invocationId: 'codex-exec-test',
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
};

describe('codex exec tools', () => {
  it('executes command and returns exited termination', async () => {
    const result = await execCommandTool.execute(
      {
        cmd: 'echo codex_exec_tool_ok',
        shell: '/bin/bash',
        login: false,
        yield_time_ms: 1000,
      },
      TEST_CONTEXT,
    );

    expect(result.termination.type).toBe('exited');
    expect(result.output).toContain('codex_exec_tool_ok');
    expect(result.text).toContain('Wall time:');
  });

  it('supports session-based stdin write roundtrip', async () => {
    const initial = await execCommandTool.execute(
      {
        cmd: 'read line; echo "$line"',
        shell: '/bin/bash',
        login: false,
        yield_time_ms: 50,
      },
      TEST_CONTEXT,
    );

    expect(initial.termination.type).toBe('ongoing');
    if (initial.termination.type !== 'ongoing') {
      return;
    }

    const result = await writeStdinTool.execute({
      session_id: initial.termination.sessionId,
      chars: 'hello-codex\n',
      yield_time_ms: 1000,
    });

    expect(result.output).toContain('hello-codex');
  });

  it('throws on unknown session id', async () => {
    await expect(
      writeStdinTool.execute({
        session_id: 999999,
        chars: '',
      }),
    ).rejects.toThrow('unknown session id');
  });
});
