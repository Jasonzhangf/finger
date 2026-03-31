import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerReportTaskCompletionTool } from '../../../../src/tools/internal/report-task-completion-tool.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';
import { getReviewRoute } from '../../../../src/agents/finger-system-agent/review-route-registry.js';

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

vi.mock('../../../../src/agents/finger-system-agent/review-route-registry.js', () => ({
  getReviewRoute: vi.fn(),
  getReviewRouteByTaskName: vi.fn(),
  removeReviewRoute: vi.fn(),
}));

describe('report-task-completion tool', () => {
  function createSessionManagerStub() {
    return {
      getSession: vi.fn().mockReturnValue(null),
      updateContext: vi.fn(),
      addMessage: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-0',
      reviewRequired: false,
      reviewAgentId: 'finger-reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);
  });

  it('returns dispatch status and id', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
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
        updateContext: vi.fn(),
        addMessage,
      },
      agentRuntimeBlock: {
        execute: vi.fn(),
      },
    }) as any);

    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-1',
      reviewRequired: false,
      reviewAgentId: 'finger-reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-1',
      taskSummary: 'Done',
      sessionId: 'session-1',
      result: 'success',
      projectId: 'proj-1',
    });

    expect((result as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: 'task-1',
      status: 'completed',
      taskReport: expect.objectContaining({
        schema: 'finger.task-report.v1',
        taskId: 'task-1',
        status: 'completed',
        summary: 'Done',
      }),
    }));
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('redispatches project work when review route exists but no delivery claim', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const runtimeExecute = vi.fn().mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-continue',
      status: 'queued',
    });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: runtimeExecute,
      },
    }) as any);

    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-continue-1',
      reviewRequired: true,
      reviewAgentId: 'finger-reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-continue-1',
      taskSummary: '继续处理中，暂未完成',
      sessionId: 'session-continue-1',
      result: 'success',
      projectId: 'proj-continue',
    }, { agentId: 'finger-project-agent' });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('continue');
    expect(runtimeExecute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-reviewer',
      targetAgentId: 'finger-project-agent',
      metadata: expect.objectContaining({
        taskId: 'task-continue-1',
        noDeliveryClaim: true,
      }),
    }));
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();
  });

  it('uses structured delivery_claim=false to force continue path even if summary looks completed', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const runtimeExecute = vi.fn().mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-continue-structured',
      status: 'queued',
    });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: runtimeExecute,
      },
    }) as any);

    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-continue-structured',
      reviewRequired: true,
      reviewAgentId: 'finger-reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-continue-structured',
      taskSummary: 'completed with evidence',
      sessionId: 'session-continue-structured',
      result: 'success',
      projectId: 'proj-continue',
      delivery_claim: false,
      status: 'in_progress',
      next_action: 'continue',
    }, { agentId: 'finger-project-agent' });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('continue');
    expect(runtimeExecute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      metadata: expect.objectContaining({
        noDeliveryClaim: true,
        taskReport: expect.objectContaining({
          taskId: 'task-continue-structured',
          status: 'in_progress',
          deliveryClaim: false,
        }),
      }),
    }));
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();
  });

  it('reviewer reject redispatches directly to project without notifying system agent', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const runtimeExecute = vi.fn().mockResolvedValue({
      ok: true,
      dispatchId: 'dispatch-reject-redispatch',
      status: 'queued',
    });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: runtimeExecute,
      },
    }) as any);

    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-reject-1',
      taskName: 'weibo-detail-refactor',
      reviewRequired: true,
      reviewAgentId: 'finger-reviewer',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-reject-1',
      taskSummary: 'BLOCK: missing dist sync and validation evidence',
      sessionId: 'session-review-1',
      result: 'failure',
      projectId: 'webauto',
      delivery_artifacts: 'dist missing common.mjs',
    }, { agentId: 'finger-reviewer' });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('continue');
    expect(runtimeExecute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-reviewer',
      targetAgentId: 'finger-project-agent',
      metadata: expect.objectContaining({
        source: 'review-reject-redispatch',
        reviewDecision: 'reject',
        taskId: 'task-reject-1',
      }),
    }));
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();
  });
});
