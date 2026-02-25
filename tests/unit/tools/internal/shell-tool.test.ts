import { describe, expect, it } from 'vitest';
import { shellExecTool } from '../../../../src/tools/internal/shell-tool.js';

describe('shell internal tool', () => {
  it('executes shell command and captures stdout', async () => {
    const result = await shellExecTool.execute(
      { command: 'echo internal_tool_ok' },
      { invocationId: 'test-1', cwd: process.cwd(), timestamp: new Date().toISOString() },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('internal_tool_ok');
  });

  it('returns non-zero exit code for failed command', async () => {
    const result = await shellExecTool.execute(
      { command: 'exit 3' },
      { invocationId: 'test-2', cwd: process.cwd(), timestamp: new Date().toISOString() },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
  });
});
