import { describe, expect, it, vi } from 'vitest';
import { HeartbeatScheduler } from '../../../src/server/modules/heartbeat-scheduler.js';

describe('HeartbeatScheduler idle gate', () => {
  it('skips heartbeat/mailbox tick when project recovery state is active', async () => {
    const execute = vi.fn(async () => ({ agents: [] }));
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listSessions: vi.fn(() => [
          {
            id: 'project-session-1',
            context: {
              projectTaskState: {
                active: true,
                status: 'in_progress',
                sourceAgentId: 'finger-system-agent',
                targetAgentId: 'finger-project-agent',
                updatedAt: new Date().toISOString(),
              },
            },
          },
        ]),
      },
    } as any);

    const dispatchDueTasksSpy = vi.spyOn(scheduler as any, 'dispatchDueTasks').mockResolvedValue(undefined);
    const dispatchNightlySpy = vi.spyOn(scheduler as any, 'dispatchNightlyDreamTasks').mockResolvedValue(undefined);
    const dispatchDailySpy = vi.spyOn(scheduler as any, 'dispatchDailySystemReviewTask').mockResolvedValue(undefined);
    const promptMailboxSpy = vi.spyOn(scheduler as any, 'promptMailboxChecks').mockResolvedValue(undefined);
    vi.spyOn(scheduler as any, 'persistRuntimeState').mockResolvedValue(undefined);
    vi.spyOn(scheduler as any, 'armTick').mockImplementation(() => undefined);

    await (scheduler as any).tick();

    expect(dispatchDueTasksSpy).not.toHaveBeenCalled();
    expect(dispatchNightlySpy).not.toHaveBeenCalled();
    expect(dispatchDailySpy).not.toHaveBeenCalled();
    expect(promptMailboxSpy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips heartbeat/mailbox tick when runtime is busy', async () => {
    const execute = vi.fn(async (command: string) => {
      if (command === 'runtime_view') {
        return {
          agents: [
            { id: 'finger-system-agent', status: 'running' },
            { id: 'finger-project-agent', status: 'idle' },
            { id: 'finger-reviewer', status: 'idle' },
          ],
        };
      }
      return { ok: true };
    });
    const scheduler = new HeartbeatScheduler({
      agentRuntimeBlock: { execute },
      sessionManager: {
        listSessions: vi.fn(() => []),
      },
    } as any);

    const dispatchDueTasksSpy = vi.spyOn(scheduler as any, 'dispatchDueTasks').mockResolvedValue(undefined);
    const promptMailboxSpy = vi.spyOn(scheduler as any, 'promptMailboxChecks').mockResolvedValue(undefined);
    vi.spyOn(scheduler as any, 'persistRuntimeState').mockResolvedValue(undefined);
    vi.spyOn(scheduler as any, 'armTick').mockImplementation(() => undefined);

    await (scheduler as any).tick();

    expect(dispatchDueTasksSpy).not.toHaveBeenCalled();
    expect(promptMailboxSpy).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith('runtime_view', {});
  });
});

