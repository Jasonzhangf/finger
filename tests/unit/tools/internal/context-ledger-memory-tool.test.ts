import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeContextLedgerMemoryMock } = vi.hoisted(() => ({
  executeContextLedgerMemoryMock: vi.fn(),
}));

vi.mock('../../../../src/runtime/context-ledger-memory.js', () => ({
  executeContextLedgerMemory: executeContextLedgerMemoryMock,
}));

import { contextLedgerMemoryTool } from '../../../../src/tools/internal/context-ledger-memory-tool.js';

describe('contextLedgerMemoryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    executeContextLedgerMemoryMock.mockResolvedValueOnce({
      ok: true,
      action: 'search',
      total: 1,
    });

    const result = await contextLedgerMemoryTool.execute(
      { action: 'search', contains: 'mailbox backlog' },
      {
        invocationId: 'tool-1',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        sessionId: 'session-auto',
        agentId: 'finger-system-agent',
      },
    );

    expect(result).toMatchObject({ ok: true, action: 'search', total: 1 });
    expect(executeContextLedgerMemoryMock).toHaveBeenCalledTimes(1);
    const input = executeContextLedgerMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.session_id).toBe('session-auto');
    expect(input.agent_id).toBe('finger-system-agent');
    expect(input._runtime_context).toMatchObject({
      session_id: 'session-auto',
      agent_id: 'finger-system-agent',
    });
  });

  it('preserves explicit runtime context values instead of overwriting them', async () => {
    executeContextLedgerMemoryMock.mockResolvedValueOnce({
      ok: true,
      action: 'query',
    });

    await contextLedgerMemoryTool.execute(
      {
        action: 'query',
        session_id: 'explicit-session',
        agent_id: 'explicit-agent',
        _runtime_context: {
          session_id: 'runtime-session',
          agent_id: 'runtime-agent',
          can_read_all: true,
        },
      },
      {
        invocationId: 'tool-2',
        cwd: process.cwd(),
        timestamp: new Date().toISOString(),
        sessionId: 'ignored-session',
        agentId: 'ignored-agent',
      },
    );

    const input = executeContextLedgerMemoryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.session_id).toBe('explicit-session');
    expect(input.agent_id).toBe('explicit-agent');
    expect(input._runtime_context).toMatchObject({
      session_id: 'runtime-session',
      agent_id: 'runtime-agent',
      can_read_all: true,
    });
  });

  it('rejects manual insert action for agents', async () => {
    await expect(
      contextLedgerMemoryTool.execute(
        { action: 'insert', text: 'forbidden' },
        {
          invocationId: 'tool-3',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId: 'session-block',
          agentId: 'finger-system-agent',
        },
      ),
    ).rejects.toThrow('action=insert is disabled');
  });
});
