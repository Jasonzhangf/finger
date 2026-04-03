import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import * as registry from '../../../src/agents/finger-system-agent/registry.js';
import { SYSTEM_PROJECT_PATH } from '../../../src/agents/finger-system-agent/index.js';
import { FINGER_PROJECT_AGENT_ID } from '../../../src/agents/finger-general/finger-general-module.js';
import { HeartbeatScheduler } from '../../../src/server/modules/heartbeat-scheduler.js';
import {
  acquireProjectDreamLock,
  releaseProjectDreamLock,
} from '../../../src/core/project-dream-lock.js';

vi.mock('../../../src/core/project-dream-lock.js', () => ({
  acquireProjectDreamLock: vi.fn(),
  releaseProjectDreamLock: vi.fn(),
  DEFAULT_PROJECT_DREAM_LOCK_TTL_MS: 8 * 60 * 60 * 1000,
}));

describe('HeartbeatScheduler nightly dream dispatch', () => {
  const fixtureRoot = path.join(process.cwd(), 'test-data', 'heartbeat-nightly-dream');
  const monitoredPath = path.join(fixtureRoot, 'monitored');
  const activeOnlyPath = path.join(fixtureRoot, 'active-only');

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T01:15:00.000+08:00'));
    vi.mocked(acquireProjectDreamLock).mockResolvedValue({
      acquired: true,
      reason: 'acquired',
      lockPath: '/tmp/.dream.lock',
    } as any);
    vi.mocked(releaseProjectDreamLock).mockResolvedValue({
      released: true,
      reason: 'released',
      lockPath: '/tmp/.dream.lock',
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    await fs.mkdir(monitoredPath, { recursive: true });
    await fs.mkdir(activeOnlyPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it('builds monitored + today-active project set and dispatches asynchronously', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: monitoredPath,
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
      {
        projectId: 'project-unmonitored',
        projectPath: path.join(fixtureRoot, 'unmonitored'),
        monitored: false,
        agentId: 'project-unmonitored-agent',
        status: 'idle',
      } as any,
    ]);

    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch') return { status: 'queued' };
      return { ok: true };
    });

    const sessionByProject = new Map<string, Array<{ id: string; lastAccessedAt: string }>>([
      [monitoredPath, [{ id: 'session-monitored', lastAccessedAt: '2026-04-01T00:10:00.000+08:00' }]],
      [activeOnlyPath, [{ id: 'session-active-only', lastAccessedAt: '2026-04-01T00:20:00.000+08:00' }]],
    ]);

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => ([
          { projectPath: monitoredPath, lastAccessedAt: '2026-04-01T00:10:00.000+08:00' },
          { projectPath: activeOnlyPath, lastAccessedAt: '2026-04-01T00:20:00.000+08:00' },
          { projectPath: SYSTEM_PROJECT_PATH, lastAccessedAt: '2026-04-01T00:21:00.000+08:00' },
        ])),
        findSessionsByProjectPath: vi.fn((projectPath: string) => sessionByProject.get(projectPath) ?? []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);

    (scheduler as any).config = {
      global: { enabled: false },
      projects: { 'project-monitored': { enabled: false } },
      nightlyDream: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: true,
        maxProjectsPerRun: 10,
        maxQueueWaitMs: 12_000,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();

    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(2);
    for (const [, payload] of dispatchCalls) {
      expect(payload).toEqual(expect.objectContaining({
        sourceAgentId: 'system-nightly-dream',
        targetAgentId: FINGER_PROJECT_AGENT_ID,
        queueOnBusy: true,
        blocking: false,
        maxQueueWaitMs: 12_000,
        metadata: expect.objectContaining({
          source: 'nightly-dream',
          dispatchReason: 'nightly_project_dream',
        }),
      }));
      expect(typeof payload.task).toBe('string');
      expect(payload.task).toContain('Nightly Project Dream Task');
      expect(payload.task).toContain('projectMemoryRoot:');
      expect(payload.task).toContain('report-task-completion');
    }
    expect(acquireProjectDreamLock).toHaveBeenCalledTimes(2);
    expect(releaseProjectDreamLock).not.toHaveBeenCalled();
  });

  it('does not dispatch duplicate nightly dream task for same project/date', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: monitoredPath,
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
    ]);

    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch') return { status: 'queued' };
      return { ok: true };
    });

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => ([
          { projectPath: monitoredPath, lastAccessedAt: '2026-04-01T00:10:00.000+08:00' },
        ])),
        findSessionsByProjectPath: vi.fn(() => ([
          { id: 'session-monitored', lastAccessedAt: '2026-04-01T00:10:00.000+08:00' },
        ])),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);

    (scheduler as any).config = {
      global: { enabled: false },
      projects: { 'project-monitored': { enabled: false } },
      nightlyDream: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: true,
        maxProjectsPerRun: 10,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    await (scheduler as any).dispatchNightlyDreamTasks();

    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(1);
    expect(acquireProjectDreamLock).toHaveBeenCalledTimes(1);
  });

  it('skips dispatch when nightly dream lock is busy', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: monitoredPath,
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
    ]);
    vi.mocked(acquireProjectDreamLock).mockResolvedValue({
      acquired: false,
      reason: 'busy',
      lockPath: '/tmp/.dream.lock',
      existingRunId: 'nightly-dream:project-monitored:2026-04-01',
    } as any);

    const execute = vi.fn(async () => ({ status: 'queued' }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
        findSessionsByProjectPath: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      nightlyDream: {
        enabled: true,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: false,
        maxDispatchRetries: 0,
        retryBackoffMs: 0,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases lock when dispatch fails immediately', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: monitoredPath,
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
    ]);
    const execute = vi.fn(async () => ({ status: 'failed' }));

    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
        findSessionsByProjectPath: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      nightlyDream: {
        enabled: true,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: false,
        maxDispatchRetries: 0,
        retryBackoffMs: 0,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    expect(releaseProjectDreamLock).toHaveBeenCalledTimes(1);
  });

  it('retries failed dispatch and succeeds within retry budget', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-monitored',
        projectPath: monitoredPath,
        monitored: true,
        agentId: 'project-monitored-agent',
        status: 'idle',
      } as any,
    ]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'queued' });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
        findSessionsByProjectPath: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      nightlyDream: {
        enabled: true,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: false,
        maxDispatchRetries: 1,
        retryBackoffMs: 0,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(2);
    expect(releaseProjectDreamLock).not.toHaveBeenCalled();
  });

  it('continues other projects even when one nightly dream dispatch fails', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([
      {
        projectId: 'project-a',
        projectPath: path.join(fixtureRoot, 'a'),
        monitored: true,
        agentId: 'project-a-agent',
        status: 'idle',
      } as any,
      {
        projectId: 'project-b',
        projectPath: path.join(fixtureRoot, 'b'),
        monitored: true,
        agentId: 'project-b-agent',
        status: 'idle',
      } as any,
    ]);
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'queued' });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
        findSessionsByProjectPath: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      nightlyDream: {
        enabled: true,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: false,
        maxDispatchRetries: 0,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(2);
    const stateMap = ((scheduler as any).nightlyDreamDispatchState as Map<string, { status: string }>);
    const statuses = Array.from(stateMap.values()).map((item) => item.status).sort();
    expect(statuses).toContain('failed');
    expect(statuses).toContain('queued');
  });

  it('dispatches daily system review once per date in window', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch') return { status: 'queued' };
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      global: { enabled: false },
      nightlyDream: { enabled: false },
      dailySystemReview: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
        maxQueueWaitMs: 9_000,
      },
    };

    await (scheduler as any).dispatchDailySystemReviewTask();
    await (scheduler as any).dispatchDailySystemReviewTask();

    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]?.[1]).toEqual(expect.objectContaining({
      sourceAgentId: 'system-daily-review',
      targetAgentId: 'finger-system-agent',
      queueOnBusy: true,
      maxQueueWaitMs: 9_000,
      metadata: expect.objectContaining({
        source: 'system-daily-review',
        dispatchReason: 'daily_system_review',
      }),
    }));
    expect(String(dispatchCalls[0]?.[1]?.task ?? '')).toContain('Daily System Review Task');
    expect(String(dispatchCalls[0]?.[1]?.task ?? '')).toContain('~/.finger/USER.md');
  });

  it('re-dispatches daily system review when previous same-day queued state is stale', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch') return { status: 'queued' };
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      global: { enabled: false },
      nightlyDream: { enabled: false },
      dailySystemReview: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
        maxQueueWaitMs: 9_000,
      },
    };
    (scheduler as any).lastDailySystemReviewDate = '2026-04-01';
    (scheduler as any).dailySystemReviewDispatchState = {
      date: '2026-04-01',
      status: 'queued',
      updatedAt: Date.now() - (11 * 60_000),
      sessionId: 'hb-session-finger-system-agent-system-daily-review',
      source: 'system-heartbeat',
      runId: 'daily-system-review:2026-04-01',
    };

    await (scheduler as any).dispatchDailySystemReviewTask();
    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(1);
  });

  it('skips today-active nightly dream candidates that are ephemeral tmp paths', async () => {
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async () => ({ status: 'queued' }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => ([
          { projectPath: '/tmp/finger-test-session-abc', lastAccessedAt: '2026-04-01T00:20:00.000+08:00' },
        ])),
        findSessionsByProjectPath: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      global: { enabled: false },
      projects: {},
      nightlyDream: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
        includeMonitoredProjects: false,
        includeTodayActiveProjects: true,
        maxProjectsPerRun: 10,
        maxQueueWaitMs: 12_000,
      },
    };

    await (scheduler as any).dispatchNightlyDreamTasks();
    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(0);
  });

  it('skips daily system review dispatch when outside configured window', async () => {
    vi.setSystemTime(new Date('2026-04-01T09:15:00.000+08:00'));
    vi.spyOn(registry, 'listAgents').mockResolvedValue([]);
    const execute = vi.fn(async (command: string) => {
      if (command === 'dispatch') return { status: 'queued' };
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listRootSessions: vi.fn(() => []),
      },
      isRuntimeChildSession: vi.fn(() => false),
    } as any);
    (scheduler as any).config = {
      global: { enabled: false },
      nightlyDream: { enabled: false },
      dailySystemReview: {
        enabled: true,
        windowStartHour: 0,
        windowEndHour: 7,
      },
    };

    await (scheduler as any).dispatchDailySystemReviewTask();
    const dispatchCalls = execute.mock.calls.filter((call: unknown[]) => call[0] === 'dispatch');
    expect(dispatchCalls).toHaveLength(0);
  });
});
