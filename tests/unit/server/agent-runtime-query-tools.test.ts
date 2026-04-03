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

function createDeps() {
  const tools = new Map<string, RegisteredTool>();
  const runtime = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    getCurrentSession: vi.fn(() => ({ id: 'session-main' })),
  };
  const execute = vi.fn(async (command: string) => {
    if (command !== 'runtime_view') return {};
    return {
      agents: [
        {
          id: 'finger-project-agent',
          status: 'running',
          lastEvent: {
            summary: 'implementing feature',
            taskId: 'task-100',
            dispatchId: 'dispatch-100',
            timestamp: '2026-04-03T10:00:00.000Z',
          },
        },
      ],
    };
  });
  const deps = {
    runtime,
    agentRuntimeBlock: { execute },
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-main', context: {} })),
    },
    primaryOrchestratorAgentId: 'finger-system-agent',
  } as any;

  registerAgentRuntimeTools(deps);
  return {
    queryTool: tools.get('agent.query'),
    progressAskTool: tools.get('agent.progress.ask'),
    execute,
  };
}

describe('agent.query / agent.progress.ask tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agent.query returns answered=true when target replied in blocking dispatch', async () => {
    vi.mocked(dispatchTaskToAgent).mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-query-1',
      status: 'completed',
      result: {
        summary: 'Target says root cause is fixed with evidence.',
      },
    } as any);
    const { queryTool } = createDeps();
    if (!queryTool) throw new Error('agent.query tool missing');

    const result = await queryTool.handler({
      target_agent_id: 'finger-project-agent',
      query: 'what is current root cause?',
      session_id: 'session-main',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    }) as Record<string, unknown>;

    expect(dispatchTaskToAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      blocking: true,
      queueOnBusy: true,
    }));
    expect(result.answered).toBe(true);
    expect(String(result.answer ?? '')).toContain('root cause');
  });

  it('agent.progress.ask returns runtime snapshot when direct answer is unavailable', async () => {
    vi.mocked(dispatchTaskToAgent).mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-progress-1',
      status: 'queued',
      result: {
        status: 'queued_mailbox',
      },
    } as any);
    const { progressAskTool, execute } = createDeps();
    if (!progressAskTool) throw new Error('agent.progress.ask tool missing');

    const result = await progressAskTool.handler({
      target_agent_id: 'finger-project-agent',
      task_id: 'task-100',
      task_name: 'stability fix',
      timeout_ms: 2000,
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    }) as Record<string, unknown>;

    expect(dispatchTaskToAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      blocking: true,
      queueOnBusy: true,
      maxQueueWaitMs: 2000,
    }));
    expect(execute).toHaveBeenCalledWith('runtime_view', {});
    expect(result.answered).toBe(false);
    expect(result.status_snapshot).toEqual(expect.objectContaining({
      found: true,
      busy: true,
      status: 'running',
      lastTaskId: 'task-100',
    }));
  });

  it('rejects self query/progress ask to avoid self-dispatch deadlock', async () => {
    const { queryTool, progressAskTool } = createDeps();
    if (!queryTool || !progressAskTool) throw new Error('query tools missing');

    await expect(queryTool.handler({
      target_agent_id: 'finger-system-agent',
      query: 'self query',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    })).rejects.toThrow(/self-dispatch forbidden/i);

    await expect(progressAskTool.handler({
      target_agent_id: 'finger-system-agent',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    })).rejects.toThrow(/self-dispatch forbidden/i);
  });
});

