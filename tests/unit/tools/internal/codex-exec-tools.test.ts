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

  it('normalizes wrapped/aliased exec_command input shape', async () => {
    const result = await execCommandTool.execute(
      {
        arguments: {
          command: 'echo exec_alias_ok',
          yieldTimeMs: '1000',
          login: 'false',
        },
      },
      TEST_CONTEXT,
    );

    expect(result.termination.type).toBe('exited');
    expect(result.output).toContain('exec_alias_ok');
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

  it('normalizes wrapped write_stdin shape and preserves empty poll chars', async () => {
    const initial = await execCommandTool.execute(
      {
        cmd: 'sleep 0.1; echo poll-ok',
        shell: '/bin/bash',
        login: false,
        yield_time_ms: 20,
      },
      TEST_CONTEXT,
    );

    expect(initial.termination.type).toBe('ongoing');
    if (initial.termination.type !== 'ongoing') return;

    const result = await writeStdinTool.execute({
      input: {
        sessionId: String(initial.termination.sessionId),
        chars: '',
        yieldTimeMs: '1000',
      },
    });

    expect(result.text).toContain('Wall time:');
  });

  it('treats late stdin write after process exit as exited polling (no hard failure)', async () => {
    const initial = await execCommandTool.execute(
      {
        cmd: 'sleep 0.2; echo done-after-exit',
        shell: '/bin/bash',
        login: false,
        yield_time_ms: 20,
      },
      TEST_CONTEXT,
    );

    expect(initial.termination.type).toBe('ongoing');
    if (initial.termination.type !== 'ongoing') {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 350));

    const result = await writeStdinTool.execute({
      session_id: initial.termination.sessionId,
      chars: 'ignored-input-after-exit\n',
      yield_time_ms: 1000,
    });

    expect(result.termination.type).toBe('exited');
    expect(result.text).toContain('Wall time:');
  });
});
