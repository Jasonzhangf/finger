import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/server/modules/agent-runtime/dispatch.js', () => ({
  dispatchTaskToAgent: vi.fn(),
}));

import { registerAgentRuntimeTools } from '../../../src/server/modules/agent-runtime.js';
import { dispatchTaskToAgent } from '../../../src/server/modules/agent-runtime/dispatch.js';

interface RegisteredTool {
  name: string;
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
}

function createDeps(sessionContext?: Record<string, unknown>) {
  const tools = new Map<string, RegisteredTool>();
  const runtime = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    getCurrentSession: vi.fn(() => ({ id: 'session-main' })),
  };

  const deps = {
    runtime,
    agentRuntimeBlock: { execute: vi.fn() },
    sessionManager: {
      getSession: vi.fn((sessionId: string) => ({
        id: sessionId,
        context: sessionContext ?? {},
      })),
    },
    primaryOrchestratorAgentId: 'finger-system-agent',
  } as any;

  registerAgentRuntimeTools(deps);
  const continueTool = tools.get('agent.continue');
  if (!continueTool) throw new Error('agent.continue tool was not registered');
  return { continueTool };
}

describe('agent.continue tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(dispatchTaskToAgent).mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-active-1',
      status: 'queued',
    } as any);
  });

  it('continues in-flight task using bound session and same task identity', async () => {
    const { continueTool } = createDeps({
      projectTaskState: {
        active: true,
        status: 'in_progress',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        updatedAt: new Date().toISOString(),
        taskId: 'task-continue-1',
        taskName: 'continue-task',
        boundSessionId: 'session-bound-1',
        revision: 2,
      },
    });

    const result = await continueTool.handler({
      target_agent_id: 'finger-project-agent',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    });

    expect((result as any).continue).toBe(true);
    expect(dispatchTaskToAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      sessionId: 'session-bound-1',
      assignment: expect.objectContaining({
        taskId: 'task-continue-1',
        taskName: 'continue-task',
      }),
      metadata: expect.objectContaining({
        source: 'agent-continue',
        continueLane: true,
      }),
    }));
  });

  it('rejects reviewer caller', async () => {
    const { continueTool } = createDeps({
      projectTaskState: {
        active: true,
        status: 'in_progress',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        updatedAt: new Date().toISOString(),
        taskId: 'task-continue-2',
      },
    });

    await expect(continueTool.handler({
      target_agent_id: 'finger-project-agent',
    }, {
      agentId: 'finger-reviewer',
      sessionId: 'session-main',
    })).rejects.toThrow(/forbidden for reviewer role/i);

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
  });

  it('requires active task identity when no task_id/task_name provided', async () => {
    const { continueTool } = createDeps({
      projectTaskState: {
        active: true,
        status: 'in_progress',
        sourceAgentId: 'finger-system-agent',
        targetAgentId: 'finger-project-agent',
        updatedAt: new Date().toISOString(),
      },
    });

    await expect(continueTool.handler({
      target_agent_id: 'finger-project-agent',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    })).rejects.toThrow(/requires active task identity/i);

    expect(dispatchTaskToAgent).not.toHaveBeenCalled();
  });
});
