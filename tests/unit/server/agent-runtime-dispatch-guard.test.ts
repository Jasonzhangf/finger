import { describe, expect, it, vi } from 'vitest';
import { registerAgentRuntimeTools } from '../../../src/server/modules/agent-runtime.js';

interface RegisteredTool {
  name: string;
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
}

function createDeps() {
  const tools = new Map<string, RegisteredTool>();
  const sessionStore = new Map<string, { id: string; context: Record<string, unknown> }>([
    ['session-1', { id: 'session-1', context: {} }],
    ['session-project-1', { id: 'session-project-1', context: {} }],
  ]);
  const execute = vi.fn(async (_command: string, payload: unknown) => ({
    ok: true,
    status: 'queued',
    dispatchId: 'dispatch-test',
    payload,
  }));
  const runtime = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    getCurrentSession: vi.fn(() => ({ id: 'session-1' })),
    bindAgentSession: vi.fn(),
  };
  const sessionManager = {
    getCurrentSession: vi.fn(() => ({ id: 'session-1' })),
    getSession: vi.fn((id: string) => sessionStore.get(id)),
    updateContext: vi.fn((id: string, patch: Record<string, unknown>) => {
      const existing = sessionStore.get(id);
      if (!existing) return false;
      existing.context = { ...existing.context, ...patch };
      return true;
    }),
    setTransientLedgerMode: vi.fn(),
    clearTransientLedgerMode: vi.fn(),
    getOrCreateSystemSession: vi.fn(() => ({ id: 'session-1' })),
  };

  const deps = {
    runtime,
    sessionManager,
    agentRuntimeBlock: { execute },
    primaryOrchestratorAgentId: 'finger-system-agent',
  } as any;

  registerAgentRuntimeTools(deps);
  const dispatchTool = tools.get('agent.dispatch');
  if (!dispatchTool) throw new Error('agent.dispatch tool was not registered');

  return { dispatchTool, execute };
}

describe('agent.dispatch runtime guards', () => {


  it('rejects source_agent_id spoofing from caller context', async () => {
    const { dispatchTool, execute } = createDeps();

    await expect(dispatchTool.handler({
      source_agent_id: 'finger-project-agent',
      target_agent_id: 'finger-reviewer',
      task: 'spoof source',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-system-1',
    })).rejects.toThrow(/source_agent_id must match caller agent/i);

    expect(execute).not.toHaveBeenCalled();
  });

  it('returns recoverable failed result for self-dispatch without throwing tool_error', async () => {
    const { dispatchTool, execute } = createDeps();

    const result = await dispatchTool.handler({
      target_agent_id: 'finger-project-agent',
      task: 'self dispatch should not throw',
    }, {
      agentId: 'finger-project-agent',
      sessionId: 'session-project-1',
    }) as {
      ok?: boolean;
      status?: string;
      error?: string;
    };

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(String(result.error ?? '')).toContain('self-dispatch forbidden');
    expect(execute).not.toHaveBeenCalled();
  });
});
