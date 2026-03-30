import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { registerProjectTaskTool } from '../../../../src/tools/internal/project-task-tool.js';

describe('project task tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('project.task.status returns busy/runtime/review snapshot', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            {
              id: 'finger-project-agent',
              status: 'running',
              lastEvent: {
                taskId: 'task-123',
                dispatchId: 'dispatch-123',
                summary: 'doing implementation',
              },
            },
          ],
        };
      }
      return {};
    });
    registerProjectTaskTool(registry, () => ({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getSession: vi.fn(() => ({
          context: {
            executionLifecycle: {
              stage: 'running',
              startedAt: '2026-03-29T00:00:00.000Z',
              lastTransitionAt: '2026-03-29T00:00:01.000Z',
              retryCount: 0,
            },
          },
        })),
      },
      runtime: {},
    }) as any);

    const result = await registry.execute('project.task.status', {
      action: 'status',
      session_id: 'session-1',
      task_id: 'task-123',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).busy).toBe(true);
    expect((result as any).taskId).toBe('task-123');
    expect((result as any).dispatchId).toBe('dispatch-123');
    expect((result as any).lifecycle?.stage).toBe('running');
  });

  it('project.task.update dispatches task update with allowDispatchWhileBusy metadata', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async (command: string, payload: Record<string, unknown>) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            { id: 'finger-project-agent', status: 'running' },
          ],
        };
      }
      if (command === 'dispatch') {
        return {
          ok: true,
          status: 'queued',
          dispatchId: 'dispatch-update-1',
          payload,
        };
      }
      return {};
    });
    registerProjectTaskTool(registry, () => ({
      agentRuntimeBlock: { execute },
      sessionManager: {
        getSession: vi.fn(() => ({ context: {} })),
      },
      runtime: {},
    }) as any);

    const result = await registry.execute('project.task.update', {
      action: 'update',
      session_id: 'session-project-1',
      task_id: 'task-1',
      update_prompt: 'Please apply new acceptance criteria and continue.',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).dispatchId).toBe('dispatch-update-1');
    expect(execute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      metadata: expect.objectContaining({
        allowDispatchWhileBusy: true,
        projectTaskUpdate: true,
      }),
      assignment: expect.objectContaining({
        task_id: 'task-1',
      }),
    }));
  });
});
