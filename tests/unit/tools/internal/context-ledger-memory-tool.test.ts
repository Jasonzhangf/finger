import { describe, expect, it, vi } from 'vitest';

const { runSpawnCommandMock } = vi.hoisted(() => ({
  runSpawnCommandMock: vi.fn(),
}));

vi.mock('../../../../src/tools/internal/spawn-runner.js', () => ({
  runSpawnCommand: runSpawnCommandMock,
}));

import { contextLedgerMemoryTool } from '../../../../src/tools/internal/context-ledger-memory-tool.js';

describe('contextLedgerMemoryTool', () => {
  it('describes ledger as canonical overflow-history retrieval path', () => {
    expect(contextLedgerMemoryTool.description).toContain('Canonical time-ordered ledger history tool');
    expect(contextLedgerMemoryTool.description).toContain('visible prompt history is incomplete or budgeted');
    const actionSchema = contextLedgerMemoryTool.inputSchema.properties.action as Record<string, unknown>;
    const containsSchema = contextLedgerMemoryTool.inputSchema.properties.contains as Record<string, unknown>;
    const slotStartSchema = contextLedgerMemoryTool.inputSchema.properties.slot_start as Record<string, unknown>;

    expect(actionSchema.description).toContain('Use search first');
    expect(containsSchema.description).toContain('history details are missing from prompt');
    expect(slotStartSchema.description).toContain('after search identified a relevant range');
  });

  it('auto-injects session and agent runtime context for tool execution', async () => {
    runSpawnCommandMock.mockResolvedValueOnce({
      stdout: '{"ok":true,"action":"search"}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    await contextLedgerMemoryTool.execute(
      { action: 'search', contains: 'mailbox backlog' },
      {
        invocationId: 'tool-1',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        sessionId: 'session-auto',
        agentId: 'finger-system-agent',
      },
    );

    expect(runSpawnCommandMock).toHaveBeenCalledTimes(1);
    const envInput = runSpawnCommandMock.mock.calls[0]?.[0]?.env?.FINGER_CONTEXT_LEDGER_TOOL_INPUT;
    expect(typeof envInput).toBe('string');
    const parsed = JSON.parse(envInput as string) as Record<string, unknown>;
    expect(parsed.session_id).toBe('session-auto');
    expect(parsed.agent_id).toBe('finger-system-agent');
    expect(parsed._runtime_context).toMatchObject({
      session_id: 'session-auto',
      agent_id: 'finger-system-agent',
    });
  });
});
