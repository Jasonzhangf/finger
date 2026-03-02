import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBlock } from '../../../src/blocks/agent-runtime-block/index.js';
import type { LoadedAgentConfig } from '../../../src/runtime/agent-json-config.js';

interface TestContext {
  block: AgentRuntimeBlock;
  hubSendToModule: ReturnType<typeof vi.fn>;
  runtimeSetConfig: ReturnType<typeof vi.fn>;
  emittedEvents: ReturnType<typeof vi.fn>;
  chatCodexListSessionStates: ReturnType<typeof vi.fn>;
  resourcePoolEntries: Array<{ id: string; status: string }>;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createContext(): Promise<TestContext> {
  const loadedAgentConfigs: LoadedAgentConfig[] = [{
    filePath: '/tmp/executor-a.agent.json',
    config: {
      id: 'executor-a',
      name: 'Executor A',
      role: 'executor',
      implementations: [
        { id: 'iflow-main', kind: 'iflow', provider: 'iflow', enabled: true },
        { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
      ],
      tools: {
        whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
      },
    },
  }];

  const modules = new Map<string, Record<string, unknown>>();
  modules.set('executor-a-loop', {
    id: 'executor-a-loop',
    name: 'executor-a-loop',
    type: 'agent',
    metadata: { role: 'executor' },
  });

  const hubSendToModule = vi.fn().mockResolvedValue({ ok: true });
  const runtimeSetConfig = vi.fn();
  const emittedEvents = vi.fn().mockResolvedValue(undefined);
  const chatCodexListSessionStates = vi.fn().mockReturnValue([]);

  const resourcePoolEntries: Array<{ id: string; status: string }> = [];

  const block = new AgentRuntimeBlock('agent-runtime-test', {
    moduleRegistry: {
      getAllModules: () => Array.from(modules.values()) as never,
      getModule: (id: string) => (modules.get(id) as never) ?? null,
    } as never,
    hub: {
      sendToModule: hubSendToModule,
    } as never,
    runtime: {
      getAgentToolPolicy: () => ({
        whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
        blacklist: [],
      }),
      getAgentRuntimeConfig: () => null,
      setAgentRuntimeConfig: runtimeSetConfig,
    } as never,
    toolRegistry: {
      list: () => [
        { name: 'agent.list', policy: 'allow' },
        { name: 'agent.capabilities', policy: 'allow' },
        { name: 'agent.deploy', policy: 'allow' },
        { name: 'agent.dispatch', policy: 'allow' },
        { name: 'agent.control', policy: 'allow' },
      ],
    } as never,
    eventBus: {
      emit: emittedEvents,
    } as never,
    workflowManager: {
      listWorkflows: () => [],
      pauseWorkflow: () => true,
      resumeWorkflow: () => true,
    },
    sessionManager: {
      pauseSession: () => true,
      resumeSession: () => true,
      getCurrentSession: () => ({ id: 'session-default' }),
    },
    chatCodexRunner: {
      listSessionStates: chatCodexListSessionStates,
      interruptSession: () => [],
    },
    resourcePool: {
      getAllResources: () => resourcePoolEntries,
      addResource: (resource: { id: string }) => {
        resourcePoolEntries.push({ id: resource.id, status: 'available' });
      },
    } as never,
    getLoadedAgentConfigs: () => loadedAgentConfigs,
    primaryOrchestratorAgentId: 'chat-codex',
  });

  await block.initialize();
  await block.start();

  return {
    block,
    hubSendToModule,
    runtimeSetConfig,
    emittedEvents,
    chatCodexListSessionStates,
    resourcePoolEntries,
  };
}

describe('AgentRuntimeBlock', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createContext();
  });

  it('returns layered catalog with implementations and startup targets', async () => {
    const catalog = await ctx.block.execute('catalog', { layer: 'full' }) as {
      ok: boolean;
      agents: Array<{ id: string; capabilities?: { execution?: { implementations?: Array<{ id: string; kind: string }> } } }>;
      startupTargets: Array<{ id: string }>;
    };

    expect(catalog.ok).toBe(true);
    const executor = catalog.agents.find((item) => item.id === 'executor-a');
    expect(executor).toBeDefined();
    expect(executor?.capabilities?.execution?.implementations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'iflow-main', kind: 'iflow' }),
      expect.objectContaining({ id: 'native-main', kind: 'native' }),
    ]));
    expect(catalog.startupTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'executor-a' }),
    ]));
  });

  it('returns base startup templates for finger role agents', async () => {
    const templates = await ctx.block.execute('list_startup_templates', {}) as Array<{ id: string; role: string }>;
    expect(templates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'finger-orchestrator', role: 'orchestrator' }),
      expect.objectContaining({ id: 'finger-researcher', role: 'searcher' }),
      expect.objectContaining({ id: 'finger-executor', role: 'executor' }),
      expect.objectContaining({ id: 'finger-coder', role: 'executor' }),
      expect.objectContaining({ id: 'finger-reviewer', role: 'reviewer' }),
    ]));
  });

  it('enforces deploy-before-dispatch and dispatches via selected implementation module', async () => {
    const beforeDeploy = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'run unit task' },
      sessionId: 'session-1',
      blocking: true,
    }) as { ok: boolean; error?: string };

    expect(beforeDeploy.ok).toBe(false);
    expect(beforeDeploy.error).toContain('not started');

    const deployResult = await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 2,
      launchMode: 'orchestrator',
    }) as { success: boolean; deployment?: { implementationId: string; moduleId?: string } };

    expect(deployResult.success).toBe(true);
    expect(deployResult.deployment?.implementationId).toBe('native-main');
    expect(deployResult.deployment?.moduleId).toBe('executor-a-loop');
    expect(ctx.resourcePoolEntries).toHaveLength(2);

    const dispatchResult = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'run unit task' },
      sessionId: 'session-1',
      blocking: true,
    }) as { ok: boolean; status: string };

    expect(dispatchResult.ok).toBe(true);
    expect(dispatchResult.status).toBe('completed');
    expect(ctx.hubSendToModule).toHaveBeenCalledWith(
      'executor-a-loop',
      expect.objectContaining({
        text: 'run unit task',
        sessionId: 'session-1',
      }),
    );
  });

  it('applies runtime provider config while deploying provider-backed targets', async () => {
    const result = await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      config: {
        provider: 'iflow',
        model: 'gpt-test',
      },
    }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(ctx.runtimeSetConfig).toHaveBeenCalledWith(
      'executor-a',
      expect.objectContaining({
        id: 'executor-a',
        provider: {
          type: 'iflow',
          model: 'gpt-test',
        },
      }),
    );
  });

  it('emits runtime events when catalog and dispatch commands are executed', async () => {
    await ctx.block.execute('catalog', { layer: 'summary' });
    await ctx.block.execute('deploy', { targetAgentId: 'executor-a' });
    await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: 'ping',
      blocking: true,
    });

    expect(ctx.emittedEvents).toHaveBeenCalled();
  });

  it('queues dispatch when target capacity is busy and drains after release', async () => {
    const first = createDeferred<{ ok: boolean }>();
    ctx.hubSendToModule.mockImplementationOnce(() => first.promise);
    ctx.hubSendToModule.mockResolvedValueOnce({ ok: true });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const firstDispatch = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 't1' },
      blocking: false,
    }) as { ok: boolean; status: string };
    expect(firstDispatch.ok).toBe(true);
    expect(firstDispatch.status).toBe('queued');

    const secondDispatch = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 't2' },
      blocking: false,
      queueOnBusy: true,
    }) as { ok: boolean; status: string; queuePosition?: number };
    expect(secondDispatch.ok).toBe(true);
    expect(secondDispatch.status).toBe('queued');
    expect(secondDispatch.queuePosition).toBe(1);
    expect(ctx.hubSendToModule).toHaveBeenCalledTimes(1);

    first.resolve({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ctx.hubSendToModule).toHaveBeenCalledTimes(2);
  });

  it('marks runtime instance as running when runner reports active turn for its session', async () => {
    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-runtime-active',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    ctx.chatCodexListSessionStates.mockReturnValue([
      {
        sessionKey: 'session-runtime-active::provider=mock',
        sessionId: 'session-runtime-active',
        providerId: 'mock',
        hasActiveTurn: true,
      },
    ]);

    const view = await ctx.block.execute('runtime_view', {}) as {
      instances: Array<{ agentId: string; sessionId?: string; status: string }>;
      agents: Array<{ id: string; status: string; runningCount: number }>;
    };

    const instance = view.instances.find((item) => item.sessionId === 'session-runtime-active' && item.agentId === 'executor-a');
    expect(instance?.status).toBe('running');

    const agent = view.agents.find((item) => item.id === 'executor-a');
    expect(agent?.status).toBe('running');
    expect(agent?.runningCount).toBeGreaterThanOrEqual(1);
  });

  it('guards against self-dispatch blocking deadlock when capacity is exhausted', async () => {
    const first = createDeferred<{ ok: boolean }>();
    ctx.hubSendToModule.mockImplementationOnce(() => first.promise);

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'executor-a',
      targetAgentId: 'executor-a',
      task: { text: 't1' },
      blocking: false,
    });

    const blocked = await ctx.block.execute('dispatch', {
      sourceAgentId: 'executor-a',
      targetAgentId: 'executor-a',
      task: { text: 't2' },
      blocking: true,
    }) as { ok: boolean; status: string; error?: string };
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toContain('deadlock');

    first.resolve({ ok: true });
  });

  it('propagates assignment lifecycle metadata through dispatch payload and events', async () => {
    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'task with assignment', taskId: 'task-42' },
      blocking: true,
      assignment: {
        epicId: 'epic-1',
        taskId: 'task-42',
        assignerAgentId: 'chat-codex',
        assigneeAgentId: 'executor-a',
        attempt: 2,
      },
    });

    expect(ctx.hubSendToModule).toHaveBeenCalledWith(
      'executor-a-loop',
      expect.objectContaining({
        metadata: expect.objectContaining({
          assignment: expect.objectContaining({
            epicId: 'epic-1',
            taskId: 'task-42',
            assignerAgentId: 'chat-codex',
            assigneeAgentId: 'executor-a',
            attempt: 2,
          }),
        }),
      }),
    );

    const completedEvent = ctx.emittedEvents.mock.calls
      .map((call) => call[0])
      .find((event: any) => event?.type === 'agent_runtime_dispatch' && event?.payload?.status === 'completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.assignment).toEqual(expect.objectContaining({
      taskId: 'task-42',
      phase: 'closed',
      attempt: 2,
    }));
  });

  it('maps reviewer decision to assignment terminal phase', async () => {
    ctx.hubSendToModule.mockResolvedValueOnce({
      success: true,
      reviewDecision: 'retry',
    });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'task with review decision', taskId: 'task-r1' },
      blocking: true,
      assignment: {
        taskId: 'task-r1',
        assignerAgentId: 'chat-codex',
        assigneeAgentId: 'executor-a',
      },
    });

    const completedEvent = ctx.emittedEvents.mock.calls
      .map((call) => call[0])
      .find((event: any) => event?.type === 'agent_runtime_dispatch' && event?.payload?.status === 'completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.assignment).toEqual(expect.objectContaining({
      taskId: 'task-r1',
      phase: 'retry',
    }));
  });

  it('exposes running/queued counters and last event in runtime view', async () => {
    const first = createDeferred<{ ok: boolean }>();
    ctx.hubSendToModule.mockImplementationOnce(() => first.promise);
    ctx.hubSendToModule.mockResolvedValueOnce({ ok: true });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 't1' },
      blocking: false,
    });
    await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 't2' },
      blocking: false,
      queueOnBusy: true,
    });

    const view = await ctx.block.execute('runtime_view', {}) as {
      agents: Array<{
        id: string;
        runningCount: number;
        queuedCount: number;
        quota: { effective: number; source: string };
        lastEvent?: { status: string };
      }>;
    };
    const agent = view.agents.find((item) => item.id === 'executor-a');
    expect(agent).toBeDefined();
    expect(agent?.runningCount).toBe(1);
    expect(agent?.queuedCount).toBe(1);
    expect(agent?.quota).toEqual(expect.objectContaining({ effective: 1, source: 'default' }));
    expect(agent?.lastEvent?.status).toBe('queued');

    first.resolve({ ok: true });
  });

  it('applies runtime quota config from deploy request', async () => {
    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      config: {
        defaultQuota: 3,
        quotaPolicy: {
          projectQuota: 2,
          workflowQuota: {
            'wf-1': 1,
          },
        },
      },
    });

    const view = await ctx.block.execute('runtime_view', {}) as {
      agents: Array<{
        id: string;
        defaultQuota: number;
        quotaPolicy: {
          projectQuota?: number;
          workflowQuota: Record<string, number>;
        };
        quota: { effective: number; source: string };
      }>;
      configs: Array<{
        id: string;
        defaultQuota?: number;
        quotaPolicy?: { projectQuota?: number; workflowQuota: Record<string, number> };
      }>;
    };

    const agent = view.agents.find((item) => item.id === 'executor-a');
    expect(agent).toBeDefined();
    expect(agent?.defaultQuota).toBe(3);
    expect(agent?.quotaPolicy.projectQuota).toBe(2);
    expect(agent?.quotaPolicy.workflowQuota['wf-1']).toBe(1);
    expect(agent?.quota).toEqual(expect.objectContaining({ effective: 2, source: 'project' }));

    const config = view.configs.find((item) => item.id === 'executor-a');
    expect(config?.defaultQuota).toBe(3);
    expect(config?.quotaPolicy?.projectQuota).toBe(2);
  });
});
