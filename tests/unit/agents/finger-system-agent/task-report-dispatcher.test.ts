import { describe, expect, it, vi } from 'vitest';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';

describe('task-report-dispatcher', () => {
  it('dispatches report to system agent with finger-project-agent source', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-123',
      status: 'queued',
    });
    const deps = {
      agentRuntimeBlock: { execute },
    } as any;

    const result = await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-1',
      taskSummary: 'summary',
      sessionId: 'session-1',
      result: 'success',
      projectId: 'project-1',
    });

    expect(result.ok).toBe(true);
    expect(result.dispatchId).toBe('dispatch-123');
    expect(result.status).toBe('queued');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-project-agent',
      targetAgentId: 'finger-system-agent',
      sessionId: 'session-1',
      blocking: false,
    }));
  });

  it('normalizes failed dispatch result', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      dispatchId: 'dispatch-failed',
      status: 'failed',
      error: 'target busy',
    });
    const deps = {
      agentRuntimeBlock: { execute },
    } as any;

    const result = await dispatchTaskToSystemAgent(deps, {
      taskId: 'task-2',
      taskSummary: 'summary',
      sessionId: 'session-2',
      result: 'failure',
      projectId: 'project-2',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('target busy');
  });
});
