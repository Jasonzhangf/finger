import { describe, expect, it, vi } from 'vitest';

import { registerReportTaskCompletionTool } from '../../../../src/tools/internal/report-task-completion-tool.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';

// Mock the dispatcher to resolve successfully
vi.mock('../../../../src/agents/finger-system-agent/task-report-dispatcher.js', () => ({
  dispatchTaskToSystemAgent: vi.fn().mockResolvedValue(undefined),
}));

// Mock the event emitter
vi.mock('../../../../src/agents/finger-system-agent/system-events.js', () => ({
  emitTaskCompleted: vi.fn(),
}));

describe('report-task-completion tool', () => {
  it('dispatches task report to system agent', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({ runtimeInstructionBus: {} }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-1',
      taskSummary: 'Done',
      sessionId: 'session-1',
      result: 'success',
      projectId: 'proj-1',
    });

    expect((result as any).ok).toBe(true);
  });
});
