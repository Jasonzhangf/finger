import { describe, expect, it, vi } from 'vitest';
import { registerAgentRuntimeTools } from '../../../src/server/modules/agent-runtime.js';

interface RegisteredTool {
  name: string;
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
}

function createDeps() {
  const tools = new Map<string, RegisteredTool>();
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
  };

  const deps = {
    runtime,
    agentRuntimeBlock: { execute },
    primaryOrchestratorAgentId: 'finger-system-agent',
  } as any;

  registerAgentRuntimeTools(deps);
  const dispatchTool = tools.get('agent.dispatch');
  if (!dispatchTool) throw new Error('agent.dispatch tool was not registered');

  return { dispatchTool, execute };
}

describe('agent.dispatch runtime guards', () => {
  it('rejects reviewer agent dispatch attempts with explicit forbidden error', async () => {
    const { dispatchTool, execute } = createDeps();

    await expect(dispatchTool.handler({
      target_agent_id: 'finger-project-agent',
      task: 'should not run',
    }, {
      agentId: 'finger-reviewer',
      sessionId: 'session-review-1',
    })).rejects.toThrow(/forbidden for reviewer role/i);

    expect(execute).not.toHaveBeenCalled();
  });

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
});
