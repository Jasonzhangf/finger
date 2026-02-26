import { describe, expect, it } from 'vitest';
import { registerDefaultRuntimeTools } from '../../../src/runtime/default-tools.js';
import { ToolRegistry } from '../../../src/runtime/tool-registry.js';

describe('registerDefaultRuntimeTools', () => {
  it('registers shell/codex tools and allows execution', async () => {
    const registry = new ToolRegistry();
    const loaded = registerDefaultRuntimeTools(registry);

    expect(loaded).toContain('shell.exec');
    expect(loaded).toContain('exec_command');
    expect(loaded).toContain('write_stdin');
    expect(loaded).toContain('apply_patch');
    expect(loaded).toContain('shell');
    expect(loaded).toContain('unified_exec');
    expect(loaded).toContain('update_plan');
    expect(loaded).toContain('view_image');
    expect(loaded).toContain('clock');
    expect(loaded).toContain('no-op');
    expect(loaded).toContain('web_search');
    expect(registry.isAvailable('shell.exec')).toBe(true);
    expect(registry.isAvailable('exec_command')).toBe(true);
    expect(registry.isAvailable('update_plan')).toBe(true);

    const result = await registry.execute('shell.exec', { command: 'echo runtime_tool_ok' }) as {
      ok: boolean;
      stdout: string;
      exitCode: number;
    };

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('runtime_tool_ok');

    const execResult = await registry.execute('exec_command', {
      cmd: 'echo runtime_codex_exec_ok',
      shell: '/bin/bash',
      login: false,
      yield_time_ms: 1000,
    }) as {
      output: string;
      termination: { type: string };
    };

    expect(execResult.output).toContain('runtime_codex_exec_ok');
    expect(execResult.termination.type).toBe('exited');
  });
});
