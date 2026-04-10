import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

import { registerReportTaskCompletionTool } from '../../../../src/tools/internal/report-task-completion-tool.js';
import { ToolRegistry } from '../../../../src/runtime/tool-registry.js';
import { dispatchTaskToSystemAgent } from '../../../../src/agents/finger-system-agent/task-report-dispatcher.js';
import { getReviewRoute } from '../../../../src/agents/finger-system-agent/review-route-registry.js';
import { releaseProjectDreamLock } from '../../../../src/core/project-dream-lock.js';
import { writeProjectDreamMemory } from '../../../../src/core/project-dream-memory-store.js';
import { FINGER_PATHS } from '../../../../src/core/finger-paths.js';
import { SYSTEM_PROJECT_PATH } from '../../../../src/agents/finger-system-agent/index.js';

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

vi.mock('../../../../src/core/project-dream-lock.js', () => ({
  releaseProjectDreamLock: vi.fn().mockResolvedValue({
    released: true,
    reason: 'released',
    lockPath: '/tmp/.dream.lock',
  }),
}));

vi.mock('../../../../src/core/project-dream-memory-store.js', () => ({
  writeProjectDreamMemory: vi.fn().mockResolvedValue({
    projectRoot: '/tmp/memory/webauto',
    memoryIndexPath: '/tmp/memory/webauto/MEMORY.md',
    dreamStatePath: '/tmp/memory/webauto/.dream.state.json',
    assetPath: '/tmp/memory/webauto/memories/2026-04-01-abc123.md',
  }),
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
      reviewAgentId: 'finger-system-agent',
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
      reviewAgentId: 'finger-system-agent',
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
      reviewAgentId: 'finger-system-agent',
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
      sourceAgentId: 'finger-system-agent',
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
      reviewAgentId: 'finger-system-agent',
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
      reviewAgentId: 'finger-system-agent',
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
    }, { agentId: 'finger-system-agent' });

    expect((result as any).ok).toBe(true);
    expect((result as any).action).toBe('continue');
    expect(runtimeExecute).toHaveBeenCalledWith('dispatch', expect.objectContaining({
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      metadata: expect.objectContaining({
        source: 'review-reject-redispatch',
        reviewDecision: 'reject',
        taskId: 'task-reject-1',
      }),
    }));
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();
  });

  it('reviewer pass updates project task lifecycle to reviewed/reported for deterministic close gate', async () => {
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    const updateContext = vi.fn();
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: {
        getSession: vi.fn().mockReturnValue({
          id: 'session-review-pass',
          context: {},
          projectPath: '/tmp/project-a',
        }),
        updateContext,
        addMessage: vi.fn(),
      },
      agentRuntimeBlock: {
        execute: vi.fn(),
      },
    }) as any);

    vi.mocked(getReviewRoute).mockReturnValue({
      taskId: 'task-pass-1',
      taskName: 'weibo-detail-refactor',
      reviewRequired: true,
      reviewAgentId: 'finger-system-agent',
      parentSessionId: 'system-session-1',
      projectSessionId: 'project-session-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'task-pass-1',
      taskSummary: 'PASS: all acceptance criteria satisfied with evidence',
      sessionId: 'project-session-1',
      result: 'success',
      projectId: 'webauto',
      delivery_artifacts: 'tests passed + screenshots',
    }, { agentId: 'finger-system-agent' });

    expect((result as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalled();
    expect(updateContext).toHaveBeenCalledWith('project-session-1', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        status: 'reviewed',
        note: 'review_passed_waiting_system_report',
      }),
    }));
    expect(updateContext).toHaveBeenCalledWith('system-session-1', expect.objectContaining({
      projectTaskState: expect.objectContaining({
        status: 'reported',
        note: 'system_report_pending_user_approval',
      }),
    }));
  });

  it('nightly dream report bypasses review route fail-close and releases dream lock', async () => {
    vi.mocked(getReviewRoute).mockReturnValue(undefined as any);
    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: vi.fn(),
      },
    }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'nightly-dream:webauto-abc123:2026-04-01',
      taskSummary: 'nightly dream completed',
      sessionId: 'session-nightly-1',
      result: 'success',
      projectId: 'webauto',
    }, { agentId: 'finger-project-agent' });

    expect((result as any).ok).toBe(true);
    expect(dispatchTaskToSystemAgent).toHaveBeenCalled();
    expect(writeProjectDreamMemory).toHaveBeenCalled();
    expect(releaseProjectDreamLock).toHaveBeenCalledWith(expect.objectContaining({
      projectSlug: 'webauto-abc123',
      runId: 'nightly-dream:webauto-abc123:2026-04-01',
    }));
  });

  it('daily system review blocks completion when append-only baseline is violated', async () => {
    vi.mocked(getReviewRoute).mockReturnValue(undefined as any);
    const runtimeStatePath = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-runtime-state.json');
    const userPath = path.join(FINGER_PATHS.home, 'USER.md');
    const flowPath = path.join(SYSTEM_PROJECT_PATH, 'FLOW.md');
    const memoryPath = path.join(SYSTEM_PROJECT_PATH, 'MEMORY.md');
    const baselineUser = '/tmp/daily-baseline-user.md';
    const baselineFlow = '/tmp/daily-baseline-flow.md';
    const baselineMemory = '/tmp/daily-baseline-memory.md';

    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath: any) => {
      const normalized = String(filePath);
      if (normalized === runtimeStatePath) {
        return JSON.stringify({
          dailySystemReviewDispatchState: {
            date: '2026-04-01',
            runId: 'daily-system-review:2026-04-01',
            appendOnly: true,
            backup: {
              enabled: false,
              localDir: '/tmp/daily-backup',
            },
            baseline: [
              { name: 'USER.md', targetPath: userPath, existed: true, snapshotPath: baselineUser },
              { name: 'FLOW.md', targetPath: flowPath, existed: true, snapshotPath: baselineFlow },
              { name: 'MEMORY.md', targetPath: memoryPath, existed: true, snapshotPath: baselineMemory },
            ],
          },
        });
      }
      if (normalized === baselineUser) return 'old-user\n';
      if (normalized === baselineFlow) return 'old-flow\n';
      if (normalized === baselineMemory) return 'old-memory\n';
      if (normalized === userPath) return 'new-user-overwrite\n';
      if (normalized === flowPath) return 'old-flow\nnew-flow\n';
      if (normalized === memoryPath) return 'old-memory\nnew-memory\n';
      return '';
    });
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined as any);
    const renameSpy = vi.spyOn(fs, 'rename').mockResolvedValue(undefined as any);

    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: vi.fn(),
      },
    }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'daily-system-review:2026-04-01',
      taskSummary: 'daily review done',
      sessionId: 'session-daily-1',
      result: 'success',
      projectId: 'system',
    }, { agentId: 'finger-system-agent' });

    expect((result as any).ok).toBe(false);
    expect(String((result as any).error)).toContain('append-only violation');
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeFileSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalled();

    readFileSpy.mockRestore();
  });

  it('daily system review keeps main flow successful when backup copy fails', async () => {
    vi.mocked(getReviewRoute).mockReturnValue(undefined as any);
    const runtimeStatePath = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-runtime-state.json');
    const userPath = path.join(FINGER_PATHS.home, 'USER.md');
    const flowPath = path.join(SYSTEM_PROJECT_PATH, 'FLOW.md');
    const memoryPath = path.join(SYSTEM_PROJECT_PATH, 'MEMORY.md');
    const baselineUser = '/tmp/daily-baseline-user-ok.md';
    const baselineFlow = '/tmp/daily-baseline-flow-ok.md';
    const baselineMemory = '/tmp/daily-baseline-memory-ok.md';

    const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementation(async (filePath: any) => {
      const normalized = String(filePath);
      if (normalized === runtimeStatePath) {
        return JSON.stringify({
          dailySystemReviewDispatchState: {
            date: '2026-04-01',
            runId: 'daily-system-review:2026-04-01',
            appendOnly: true,
            backup: {
              enabled: true,
              localDir: '/tmp/daily-backup-local',
              obsidianDir: '/tmp/daily-backup-obsidian',
            },
            baseline: [
              { name: 'USER.md', targetPath: userPath, existed: true, snapshotPath: baselineUser },
              { name: 'FLOW.md', targetPath: flowPath, existed: true, snapshotPath: baselineFlow },
              { name: 'MEMORY.md', targetPath: memoryPath, existed: true, snapshotPath: baselineMemory },
            ],
          },
        });
      }
      if (normalized === baselineUser) return 'old-user\n';
      if (normalized === baselineFlow) return 'old-flow\n';
      if (normalized === baselineMemory) return 'old-memory\n';
      if (normalized === userPath) return 'old-user\nnew-user\n';
      if (normalized === flowPath) return 'old-flow\nnew-flow\n';
      if (normalized === memoryPath) return 'old-memory\nnew-memory\n';
      return '';
    });

    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'rename').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'access').mockResolvedValue(undefined as any);
    vi.spyOn(fs, 'copyFile').mockImplementation(async (_src: any, dest: any) => {
      const normalizedDest = String(dest);
      if (normalizedDest.includes('/tmp/daily-backup-obsidian/')) {
        throw new Error('obsidian-dir-not-writable');
      }
      return undefined as any;
    });

    const registry = new ToolRegistry({ internalRegistry: undefined, tools: [] });
    registerReportTaskCompletionTool(registry, () => ({
      runtimeInstructionBus: {},
      sessionManager: createSessionManagerStub(),
      agentRuntimeBlock: {
        execute: vi.fn(),
      },
    }) as any);

    const result = await registry.execute('report-task-completion', {
      action: 'report',
      taskId: 'daily-system-review:2026-04-01',
      taskSummary: 'daily review done',
      sessionId: 'session-daily-2',
      result: 'success',
      projectId: 'system',
    }, { agentId: 'finger-system-agent' });

    expect((result as any).ok).toBe(true);
    expect((result as any).status).toBe('completed');
    expect(Array.isArray((result as any).warnings)).toBe(true);
    expect(((result as any).warnings as string[]).some((line) => line.includes('obsidian'))).toBe(true);
    expect(dispatchTaskToSystemAgent).not.toHaveBeenCalled();

    readFileSpy.mockRestore();
  });
});
