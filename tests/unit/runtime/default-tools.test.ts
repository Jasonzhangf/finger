import { describe, expect, it } from 'vitest';
import { registerDefaultRuntimeTools } from '../../../src/runtime/default-tools.js';
import { ToolRegistry } from '../../../src/runtime/tool-registry.js';

describe('registerDefaultRuntimeTools', () => {
  it('registers shell.exec and allows execution', async () => {
    const registry = new ToolRegistry();
    const loaded = registerDefaultRuntimeTools(registry);

    expect(loaded).toContain('shell.exec');
    expect(registry.isAvailable('shell.exec')).toBe(true);

    const result = await registry.execute('shell.exec', { command: 'echo runtime_tool_ok' }) as {
      ok: boolean;
      stdout: string;
      exitCode: number;
    };

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('runtime_tool_ok');
  });
});
