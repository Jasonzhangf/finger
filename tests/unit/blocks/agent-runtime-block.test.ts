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

async function createContextWithLoadedConfigs(loadedAgentConfigs: LoadedAgentConfig[]): Promise<TestContext> {
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
      expect.objectContaining({ id: 'finger-project-agent', role: 'project' }),
      expect.objectContaining({ id: 'finger-system-agent', role: 'system' }),
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
        text: expect.stringContaining('[ASSIGNED TASK]\nrun unit task'),
        sessionId: 'session-1',
      }),
    );
  });

  it('treats blocking dispatch result with success=false as failed (timeout-safe)', async () => {
    ctx.hubSendToModule.mockResolvedValueOnce({
      success: false,
      error: 'chat-codex timed out after 600000ms',
    });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const dispatchResult = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'long running task' },
      sessionId: 'session-1',
      blocking: true,
    }) as { ok: boolean; status: string; error?: string };

    expect(dispatchResult.ok).toBe(false);
    expect(dispatchResult.status).toBe('failed');
    expect(dispatchResult.error).toContain('timed out');
  });

  it('emits failed dispatch event for non-blocking timeout-like result', async () => {
    ctx.hubSendToModule.mockResolvedValueOnce({
      success: false,
      error: 'chat-codex timed out after 600000ms',
    });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const dispatchResult = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'long running task' },
      sessionId: 'session-1',
      blocking: false,
    }) as { ok: boolean; status: string; dispatchId: string };

    expect(dispatchResult.ok).toBe(true);
    expect(dispatchResult.status).toBe('queued');

    await new Promise((resolve) => setTimeout(resolve, 0));

    const dispatchEvents = ctx.emittedEvents.mock.calls
      .map((call) => call[0])
      .filter((event: any) => event?.type === 'agent_runtime_dispatch' && event?.payload?.dispatchId === dispatchResult.dispatchId);

    const failedEvent = dispatchEvents.find((event: any) => event?.payload?.status === 'failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload?.error).toContain('timed out');

    const completedEvent = dispatchEvents.find((event: any) => event?.payload?.status === 'completed');
    expect(completedEvent).toBeUndefined();
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

  it('rejects self-dispatch immediately', async () => {
    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const blocked = await ctx.block.execute('dispatch', {
      sourceAgentId: 'executor-a',
      targetAgentId: 'executor-a',
      task: { text: 'self' },
      blocking: false,
    }) as { ok: boolean; status: string; error?: string };
    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toContain('self-dispatch forbidden');
    expect(ctx.hubSendToModule).not.toHaveBeenCalled();
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

  it('sanitizes blocking dispatch result to summary payload instead of raw child metadata', async () => {
    ctx.hubSendToModule.mockResolvedValueOnce({
      success: true,
      response: JSON.stringify({
        role: 'executor',
        summary: '完成修复并更新 src/app.ts',
        status: 'completed',
        outputs: [{ type: 'file', path: 'src/app.ts', description: 'patched file' }],
        evidence: [{ tool: 'exec_command', detail: 'npm test passed' }],
        nextAction: '等待编排者继续',
      }),
      sessionId: 'child-session-1',
      metadata: {
        api_history: [{ huge: true }],
        eventCount: 99,
      },
    });

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const dispatchResult = await ctx.block.execute('dispatch', {
      sourceAgentId: 'chat-codex',
      targetAgentId: 'executor-a',
      task: { text: 'fix it' },
      blocking: true,
    }) as { ok: boolean; status: string; result?: Record<string, unknown> };

    expect(dispatchResult.ok).toBe(true);
    expect(dispatchResult.status).toBe('completed');
    expect(dispatchResult.result).toEqual(expect.objectContaining({
      summary: '完成修复并更新 src/app.ts',
      status: 'completed',
      childSessionId: 'child-session-1',
      keyFiles: ['src/app.ts'],
    }));
    expect(dispatchResult.result).not.toHaveProperty('metadata');
    expect(dispatchResult.result).not.toHaveProperty('response');
  });

  it('injects dispatch contract and structured output metadata into child task payload', async () => {
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
      task: {
        text: '修复 dispatch 逻辑',
        goal: '让主编排器只接收 summary',
        acceptance: ['返回 summary', '包含关键文件路径'],
      },
      blocking: true,
    });

    expect(ctx.hubSendToModule).toHaveBeenCalledWith(
      'executor-a-loop',
      expect.objectContaining({
        text: expect.stringContaining('[DISPATCH CONTRACT]'),
        metadata: expect.objectContaining({
          responsesStructuredOutput: true,
          responsesOutputSchemaPreset: 'orchestrator',
        }),
      }),
    );
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
    expect(agent?.quota).toEqual(expect.objectContaining({ effective: 1, source: 'deployment' }));
    expect(agent?.lastEvent?.status).toBe('queued');

    first.resolve({ ok: true });
  });

  it('isolates busy/queue by dispatch lane and exposes lanes in runtime view', async () => {
    const first = createDeferred<{ ok: boolean }>();
    const second = createDeferred<{ ok: boolean }>();
    ctx.hubSendToModule.mockImplementationOnce(() => first.promise);
    ctx.hubSendToModule.mockImplementationOnce(() => second.promise);

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-worker-lisa',
      task: { text: 'project-a task', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Lisa' },
      blocking: false,
    });
    await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-worker-robert',
      task: { text: 'project-b task', projectId: 'project-b' },
      metadata: { projectId: 'project-b', workerId: 'Robert' },
      blocking: false,
      queueOnBusy: true,
    });

    expect(ctx.hubSendToModule).toHaveBeenCalledTimes(2);

    const view = await ctx.block.execute('runtime_view', {}) as {
      agents: Array<{ id: string; runningCount: number; queuedCount: number }>;
      lanes: Array<{ laneKey: string; agentId: string; runningCount: number; queuedCount: number }>;
    };

    const agent = view.agents.find((item) => item.id === 'executor-a');
    expect(agent?.runningCount).toBe(2);
    expect(agent?.queuedCount).toBe(0);
    expect(view.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneKey: 'project-a:Lisa:session-worker-lisa',
        agentId: 'executor-a',
        runningCount: 1,
      }),
      expect.objectContaining({
        laneKey: 'project-b:Robert:session-worker-robert',
        agentId: 'executor-a',
        runningCount: 1,
      }),
    ]));

    first.resolve({ ok: true });
    second.resolve({ ok: true });
  });

  it('supports Jason scenario: A->Lisa, B->Robert, A-feature->Kelvin parallel lanes', async () => {
    const lisa = createDeferred<{ ok: boolean }>();
    const robert = createDeferred<{ ok: boolean }>();
    const kelvin = createDeferred<{ ok: boolean }>();
    ctx.hubSendToModule.mockImplementationOnce(() => lisa.promise);
    ctx.hubSendToModule.mockImplementationOnce(() => robert.promise);
    ctx.hubSendToModule.mockImplementationOnce(() => kelvin.promise);

    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-project-a-lisa',
      task: { text: 'Task A main implementation', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Lisa' },
      blocking: false,
    });
    await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-project-b-robert',
      task: { text: 'Task B independent implementation', projectId: 'project-b' },
      metadata: { projectId: 'project-b', workerId: 'Robert' },
      blocking: false,
    });
    await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-project-a-kelvin',
      task: { text: 'Task A feature extension', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Kelvin' },
      blocking: false,
    });

    expect(ctx.hubSendToModule).toHaveBeenCalledTimes(3);

    const view = await ctx.block.execute('runtime_view', {}) as {
      agents: Array<{ id: string; runningCount: number; queuedCount: number }>;
      lanes: Array<{ laneKey: string; agentId: string; runningCount: number; queuedCount: number }>;
    };
    const agent = view.agents.find((item) => item.id === 'executor-a');
    expect(agent?.runningCount).toBe(3);
    expect(agent?.queuedCount).toBe(0);
    expect(view.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneKey: 'project-a:Lisa:session-project-a-lisa',
        runningCount: 1,
        queuedCount: 0,
      }),
      expect.objectContaining({
        laneKey: 'project-b:Robert:session-project-b-robert',
        runningCount: 1,
        queuedCount: 0,
      }),
      expect.objectContaining({
        laneKey: 'project-a:Kelvin:session-project-a-kelvin',
        runningCount: 1,
        queuedCount: 0,
      }),
    ]));

    lisa.resolve({ ok: true });
    robert.resolve({ ok: true });
    kelvin.resolve({ ok: true });
  });

  it('enforces immutable (project,worker)->session binding and rejects cross-worker session reuse', async () => {
    await ctx.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
      launchMode: 'orchestrator',
    });

    const ok = await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-worker-lisa',
      task: { text: 'initial', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Lisa' },
      blocking: true,
    }) as { ok: boolean };
    expect(ok.ok).toBe(true);

    const mismatch = await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-worker-lisa-2',
      task: { text: 'same worker, wrong session', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Lisa' },
      blocking: true,
    }) as { ok: boolean; error?: string };
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toContain('session_binding_mismatch');

    const crossWorkerReuse = await ctx.block.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'executor-a',
      sessionId: 'session-worker-lisa',
      task: { text: 'other worker reuses session', projectId: 'project-a' },
      metadata: { projectId: 'project-a', workerId: 'Robert' },
      blocking: true,
    }) as { ok: boolean; error?: string };
    expect(crossWorkerReuse.ok).toBe(false);
    expect(crossWorkerReuse.error).toContain('session_binding_scope_violation');
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

  it('reads enabled from agent.json top-level field in runtime view', async () => {
    const custom = await createContextWithLoadedConfigs([
      {
        filePath: '/tmp/executor-a.agent.json',
        config: {
          id: 'executor-a',
          name: 'Executor A',
          role: 'executor',
          enabled: false,
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
          ],
          tools: {
            whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
          },
        },
      },
    ]);

    const runtimeView = await custom.block.execute('runtime_view', {}) as {
      agents: Array<{ id: string; enabled: boolean; instanceCount: number }>;
      configs: Array<{ id: string; enabled: boolean }>;
    };

    expect(runtimeView.agents.find((item) => item.id === 'executor-a')?.enabled).toBe(false);
    expect(runtimeView.configs.find((item) => item.id === 'executor-a')?.enabled).toBe(false);
  });

  it('does not let stale base profile override explicit runtime enabled patch', async () => {
    const loadedAgentConfigs: LoadedAgentConfig[] = [
      {
        filePath: '/tmp/executor-a.agent.json',
        config: {
          id: 'executor-a',
          name: 'Executor A',
          role: 'executor',
          enabled: true,
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
          ],
          tools: {
            whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
          },
        },
      },
    ];
    const custom = await createContextWithLoadedConfigs(loadedAgentConfigs);

    await custom.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      config: {
        enabled: false,
      },
    });

    const runtimeView = await custom.block.execute('runtime_view', {}) as {
      agents: Array<{ id: string; enabled: boolean }>;
      configs: Array<{ id: string; enabled: boolean }>;
    };

    expect(runtimeView.agents.find((item) => item.id === 'executor-a')?.enabled).toBe(true);
    expect(runtimeView.agents.find((item) => item.id === 'executor-a')?.instanceCount).toBe(0);
    expect(runtimeView.configs.find((item) => item.id === 'executor-a')?.enabled).toBe(true);
  });

  it('reads defaultQuota and quotaPolicy from agent.json runtime view config snapshot', async () => {
    const custom = await createContextWithLoadedConfigs([
      {
        filePath: '/tmp/executor-a.agent.json',
        config: {
          id: 'executor-a',
          name: 'Executor A',
          role: 'executor',
          enabled: false,
          defaultQuota: 3,
          quotaPolicy: {
            projectQuota: 2,
            workflowQuota: {
              'wf-1': 1,
            },
          },
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
          ],
          tools: {
            whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
          },
        },
      },
    ]);

    const runtimeView = await custom.block.execute('runtime_view', {}) as {
      configs: Array<{
        id: string;
        enabled?: boolean;
        defaultQuota?: number;
        quotaPolicy?: { projectQuota?: number; workflowQuota?: Record<string, number> };
      }>;
    };

    const config = runtimeView.configs.find((item) => item.id === 'executor-a');
    expect(config?.enabled).toBe(false);
    expect(config?.defaultQuota).toBe(3);
    expect(config?.quotaPolicy?.projectQuota).toBe(2);
    expect(config?.quotaPolicy?.workflowQuota?.['wf-1']).toBe(1);
  });

  it('removes deployment from runtime view when agent is disabled', async () => {
    const custom = await createContextWithLoadedConfigs([
      {
        filePath: '/tmp/executor-a.agent.json',
        config: {
          id: 'executor-a',
          name: 'Executor A',
          role: 'executor',
          enabled: true,
          implementations: [
            { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
          ],
          tools: {
            whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
          },
        },
      },
    ]);

    await custom.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      instanceCount: 1,
    });

    await custom.block.execute('deploy', {
      targetAgentId: 'executor-a',
      targetImplementationId: 'native-main',
      sessionId: 'session-1',
      config: { enabled: false },
    });

    const runtimeView = await custom.block.execute('runtime_view', {}) as {
      agents: Array<{ id: string; instanceCount: number; enabled: boolean }>;
      instances: Array<{ agentId: string }>;
    };

    const agent = runtimeView.agents.find((item) => item.id === 'executor-a');
    expect(agent?.enabled).toBe(true);
    expect(agent?.instanceCount).toBe(0);
    expect(runtimeView.instances.find((item) => item.agentId === 'executor-a')).toBeUndefined();
  });
});

  describe('Phase 5: Deployment-based quota', () => {
    it('uses deployment instanceCount as quota when no explicit defaultQuota configured', async () => {
      const custom = await createContextWithLoadedConfigs([
        {
          filePath: '/tmp/executor-a.agent.json',
          config: {
            id: 'executor-a',
            name: 'Executor A',
            role: 'executor',
            enabled: true,
            // Note: defaultQuota NOT configured
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
            ],
            tools: {
              whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
            },
          },
        },
      ]);

      // Deploy with instanceCount=3
      await custom.block.execute('deploy', {
        targetAgentId: 'executor-a',
        targetImplementationId: 'native-main',
        sessionId: 'session-1',
        instanceCount: 3,
      });

      const runtimeView = await custom.block.execute('runtime_view', {}) as {
        agents: Array<{
          id: string;
          quota: { effective: number; source: string };
        }>;
      };

      const agent = runtimeView.agents.find((item) => item.id === 'executor-a');
      expect(agent?.quota.effective).toBe(3);
      expect(agent?.quota.source).toBe('deployment');
      expect(agent?.defaultQuota).toBeUndefined();
    });

    
    it('uses explicit defaultQuota=5 when configured', async () => {
      const custom = await createContextWithLoadedConfigs([
        {
          filePath: '/tmp/executor-a.agent.json',
          config: {
            id: 'executor-a',
            name: 'Executor A',
            role: 'executor',
            enabled: true,
            defaultQuota: 5, // Explicit defaultQuota
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
            ],
            tools: {
              whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
            },
          },
        },
      ]);

      // Deploy with instanceCount=3 (should not override explicit defaultQuota)
      await custom.block.execute('deploy', {
        targetAgentId: 'executor-a',
        targetImplementationId: 'native-main',
        sessionId: 'session-1',
        instanceCount: 3,
      });

      const runtimeView = await custom.block.execute('runtime_view', {}) as {
        agents: Array<{
          id: string;
          quota: { effective: number; source: string };
          defaultQuota?: number;
        }>;
      };

      const agent = runtimeView.agents.find((item) => item.id === 'executor-a');
      expect(agent?.quota.effective).toBe(5);
      expect(agent?.quota.source).toBe('defaultQuota');
      expect(agent?.defaultQuota).toBe(5);
    });
it('prioritizes explicit defaultQuota=1 over deployment instanceCount=3', async () => {
      const custom = await createContextWithLoadedConfigs([
        {
          filePath: '/tmp/executor-a.agent.json',
          config: {
            id: 'executor-a',
            name: 'Executor A',
            role: 'executor',
            enabled: true,
            defaultQuota: 1, // Explicit defaultQuota
            implementations: [
              { id: 'native-main', kind: 'native', moduleId: 'executor-a-loop', enabled: true },
            ],
            tools: {
              whitelist: ['agent.list', 'agent.capabilities', 'agent.deploy', 'agent.dispatch', 'agent.control'],
            },
          },
        },
      ]);

      // Deploy with instanceCount=3
      await custom.block.execute('deploy', {
        targetAgentId: 'executor-a',
        targetImplementationId: 'native-main',
        sessionId: 'session-1',
        instanceCount: 3,
      });

      const runtimeView = await custom.block.execute('runtime_view', {}) as {
        agents: Array<{
          id: string;
          quota: { effective: number; source: string };
        }>;
      };

      const agent = runtimeView.agents.find((item) => item.id === 'executor-a');
      expect(agent?.quota.effective).toBe(1);
      expect(agent?.quota.source).toBe('defaultQuota');
    });
  });
