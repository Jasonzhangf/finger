import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntimeBlock } from '../../../src/blocks/agent-runtime-block/index.js';
import type { LoadedAgentConfig } from '../../../src/runtime/agent-json-config.js';

interface TestContext {
  block: AgentRuntimeBlock;
  hubSendToModule: ReturnType<typeof vi.fn>;
  runtimeSetConfig: ReturnType<typeof vi.fn>;
  emittedEvents: ReturnType<typeof vi.fn>;
  resourcePoolEntries: Array<{ id: string; status: string }>;
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
      listSessionStates: () => [],
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
});
