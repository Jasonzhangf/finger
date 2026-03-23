import { describe, expect, it, vi } from 'vitest';

import { registerReportTaskCompletionTool } from '../../../../src/tools/internal/report-task-completion-tool.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';

// Mock the dispatcher to resolve successfully
vi.mock('../../../../src/agents/finger-system-agent/task-report-dispatcher.js', () => ({
  dispatchTaskToSystemAgent: vi.fn().mockResolvedValue({
    ok: true,
    dispatchId: 'dispatch-test',
    status: 'queued',
  }),
}));

// Mock the event emitter
vi.mock('../../../../src/agents/finger-system-agent/system-events.js', () => ({
  emitTaskCompleted: vi.fn(),
}));

describe('report-task-completion tool', () => {
  it('returns dispatch status and id', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: {
        getSession: vi.fn().mockReturnValue(null),
        addMessage: vi.fn(),
      },
    }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-0',
      taskSummary: 'Done',
      sessionId: 'session-0',
      result: 'success',
      projectId: 'proj-0',
    });

    expect((result as any).ok).toBe(true);
    expect((result as any).dispatchId).toBe('dispatch-test');
    expect((result as any).status).toBe('queued');
  });

  it('dispatches task report to system agent', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const addMessage = vi.fn().mockResolvedValue(undefined);
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: {
        getSession: vi.fn().mockReturnValue({ id: 'session-1' }),
        addMessage,
      },
    }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-1',
      taskSummary: 'Done',
      sessionId: 'session-1',
      result: 'success',
      projectId: 'proj-1',
    });

    expect((result as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledWith(
      'session-1',
      'system',
      expect.stringContaining('任务完成已上报给 system'),
      expect.objectContaining({ type: 'dispatch' }),
    );
  });
});
