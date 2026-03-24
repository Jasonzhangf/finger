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
    expect(loaded).toContain('permission.check');
    expect(loaded).toContain('permission.grant');
    expect(loaded).toContain('permission.deny');
    expect(loaded).toContain('permission.list');
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

  it('registers system/project runtime tools when deps are provided', () => {
    const registry = new ToolRegistry();
    const loaded = registerDefaultRuntimeTools(registry, (() => ({
      sessionManager: {},
      agentRuntimeBlock: {},
    })) as any);

    expect(loaded).toContain('project_tool');
    expect(loaded).toContain('system-registry-tool');
    expect(loaded).toContain('report-task-completion');
    expect(registry.isAvailable('project_tool')).toBe(true);
    expect(registry.isAvailable('system-registry-tool')).toBe(true);
    expect(registry.isAvailable('report-task-completion')).toBe(true);
  });
});
